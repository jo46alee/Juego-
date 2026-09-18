import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express();
const PORT=Number(process.env.PORT||3000);
const JWT_SECRET=process.env.JWT_SECRET||"dev-secret";
const FEE=Number(process.env.MARKET_FEE_PERCENT||3);
const db=new Database(process.env.DB_FILE||"./data/gamefi.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS planets(
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
 name TEXT NOT NULL, metal REAL NOT NULL DEFAULT 1000, crystal REAL NOT NULL DEFAULT 500,
 deuterium REAL NOT NULL DEFAULT 100, energy REAL NOT NULL DEFAULT 100,
 last_tick INTEGER NOT NULL, metal_mine INTEGER NOT NULL DEFAULT 1,
 crystal_mine INTEGER NOT NULL DEFAULT 1, deut_synth INTEGER NOT NULL DEFAULT 1,
 power_plant INTEGER NOT NULL DEFAULT 1, FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS wallets(
 user_id INTEGER PRIMARY KEY, tsx REAL NOT NULL DEFAULT 1000, usdt REAL NOT NULL DEFAULT 0,
 FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS ledger(
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, asset TEXT NOT NULL,
 amount REAL NOT NULL, type TEXT NOT NULL, reference TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS listings(
 id INTEGER PRIMARY KEY AUTOINCREMENT, seller_id INTEGER NOT NULL, asset TEXT NOT NULL,
 quantity REAL NOT NULL, price REAL NOT NULL, status TEXT NOT NULL DEFAULT 'open',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(seller_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS missions(
 id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
 description TEXT NOT NULL, reward_tsx REAL NOT NULL, reward_metal REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user_missions(
 user_id INTEGER NOT NULL, mission_id INTEGER NOT NULL, completed_at TEXT,
 PRIMARY KEY(user_id,mission_id)
);
`);

const missions=[
["first_build","Primer desarrollo","Mejora cualquier edificio una vez.",100,500],
["rich_planet","Planeta próspero","Alcanza 5.000 de Metal.",250,1000],
["market_trader","Primer comercio","Completa una compra en el mercado.",150,0]
];
const insertMission=db.prepare("INSERT OR IGNORE INTO missions(code,title,description,reward_tsx,reward_metal) VALUES(?,?,?,?,?)");
for(const m of missions) insertMission.run(...m);

app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname,"public")));

function sign(user){return jwt.sign({id:user.id,username:user.username,role:user.role},JWT_SECRET,{expiresIn:"7d"});}
function auth(req,res,next){
 const h=req.headers.authorization||"";
 if(!h.startsWith("Bearer ")) return res.status(401).json({error:"No autenticado"});
 try{req.user=jwt.verify(h.slice(7),JWT_SECRET);next();}catch{return res.status(401).json({error:"Token inválido o expirado"});}
}
function userPlanet(uid){
 let p=db.prepare("SELECT * FROM planets WHERE user_id=?").get(uid);
 if(!p) return null;
 const now=Date.now(), elapsed=Math.max(0,Math.min(now-p.last_tick,86400000));
 const hours=elapsed/3600000;
 const metalGain=30*p.metal_mine*Math.pow(1.15,p.metal_mine-1)*hours;
 const crystalGain=20*p.crystal_mine*Math.pow(1.15,p.crystal_mine-1)*hours;
 const deutGain=8*p.deut_synth*Math.pow(1.15,p.deut_synth-1)*hours;
 db.prepare("UPDATE planets SET metal=metal+?,crystal=crystal+?,deuterium=deuterium+?,last_tick=? WHERE id=?")
   .run(metalGain,crystalGain,deutGain,now,p.id);
 return db.prepare("SELECT * FROM planets WHERE id=?").get(p.id);
}
function wallet(uid){return db.prepare("SELECT * FROM wallets WHERE user_id=?").get(uid);}
function cost(level,type){
 const base={metal_mine:[120,70,0],crystal_mine:[180,110,0],deut_synth:[225,160,20],power_plant:[90,70,0]}[type];
 const f=Math.pow(1.55,level-1);
 return {metal:Math.ceil(base[0]*f),crystal:Math.ceil(base[1]*f),deuterium:Math.ceil(base[2]*f)};
}
function audit(uid,asset,amount,type,reference){
 db.prepare("INSERT INTO ledger(user_id,asset,amount,type,reference) VALUES(?,?,?,?,?)").run(uid,asset,amount,type,reference||null);
}

app.post("/api/auth/register",(req,res)=>{
 const username=String(req.body.username||"").trim().toLowerCase(), password=String(req.body.password||"");
 if(!/^[a-z0-9_]{3,20}$/.test(username)||password.length<6) return res.status(400).json({error:"Usuario 3-20 caracteres y contraseña de mínimo 6."});
 try{
  const info=db.prepare("INSERT INTO users(username,password_hash) VALUES(?,?)").run(username,bcrypt.hashSync(password,10));
  const uid=info.lastInsertRowid, now=Date.now();
  db.prepare("INSERT INTO planets(user_id,name,last_tick) VALUES(?,?,?)").run(uid,username+"'s World",now);
  db.prepare("INSERT INTO wallets(user_id,tsx,usdt) VALUES(?,?,?)").run(uid,Number(process.env.START_TSX||1000),Number(process.env.START_USDT||0));
  audit(uid,"TSX",Number(process.env.START_TSX||1000),"bonus","welcome");
  const user=db.prepare("SELECT id,username,role FROM users WHERE id=?").get(uid);
  res.json({token:sign(user),user});
 }catch(e){res.status(409).json({error:"El usuario ya existe."});}
});
app.post("/api/auth/login",(req,res)=>{
 const u=db.prepare("SELECT * FROM users WHERE username=?").get(String(req.body.username||"").trim().toLowerCase());
 if(!u||!bcrypt.compareSync(String(req.body.password||""),u.password_hash)) return res.status(401).json({error:"Credenciales incorrectas"});
 res.json({token:sign(u),user:{id:u.id,username:u.username,role:u.role}});
});
app.get("/api/me",auth,(req,res)=>{
 const p=userPlanet(req.user.id), w=wallet(req.user.id);
 res.json({user:req.user,planet:p,wallet:w,fee_percent:FEE});
});
app.get("/api/leaderboard",(req,res)=>{
 const rows=db.prepare(`SELECT u.username,p.metal+p.crystal+p.deuterium AS resources,p.metal,p.crystal,p.deuterium
 FROM users u JOIN planets p ON p.user_id=u.id ORDER BY resources DESC LIMIT 20`).all();
 res.json(rows);
});
app.post("/api/build/upgrade",auth,(req,res)=>{
 const type=String(req.body.type||"");
 if(!["metal_mine","crystal_mine","deut_synth","power_plant"].includes(type)) return res.status(400).json({error:"Edificio inválido"});
 const p=userPlanet(req.user.id), level=p[type], c=cost(level,type);
 if(p.metal<c.metal||p.crystal<c.crystal||p.deuterium<c.deuterium) return res.status(400).json({error:"Recursos insuficientes",cost:c});
 const next=level+1;
 db.prepare(`UPDATE planets SET metal=metal-?,crystal=crystal-?,deuterium=deuterium-?,${type}=? WHERE id=?`)
   .run(c.metal,c.crystal,c.deuterium,next,p.id);
 completeBuildMission(req.user.id);
 res.json({planet:userPlanet(req.user.id),cost:c});
});
function completeBuildMission(uid){
 const m=db.prepare("SELECT * FROM missions WHERE code='first_build'").get();
 const old=db.prepare("SELECT * FROM user_missions WHERE user_id=? AND mission_id=?").get(uid,m.id);
 if(!old){
  db.prepare("INSERT INTO user_missions(user_id,mission_id,completed_at) VALUES(?,?,CURRENT_TIMESTAMP)").run(uid,m.id);
  db.prepare("UPDATE wallets SET tsx=tsx+? WHERE user_id=?").run(m.reward_tsx,uid);
  audit(uid,"TSX",m.reward_tsx,"mission",m.code);
  const p=userPlanet(uid); db.prepare("UPDATE planets SET metal=metal+? WHERE id=?").run(m.reward_metal,p.id);
 }
}
app.get("/api/missions",auth,(req,res)=>{
 const rows=db.prepare(`SELECT m.*,um.completed_at FROM missions m LEFT JOIN user_missions um ON um.mission_id=m.id AND um.user_id=?`).all(req.user.id);
 res.json(rows);
});
app.post("/api/missions/check",auth,(req,res)=>{
 const p=userPlanet(req.user.id), m=db.prepare("SELECT * FROM missions WHERE code='rich_planet'").get();
 if(p.metal>=5000&&!db.prepare("SELECT 1 FROM user_missions WHERE user_id=? AND mission_id=?").get(req.user.id,m.id)){
  db.prepare("INSERT INTO user_missions(user_id,mission_id,completed_at) VALUES(?,?,CURRENT_TIMESTAMP)").run(req.user.id,m.id);
  db.prepare("UPDATE wallets SET tsx=tsx+? WHERE user_id=?").run(m.reward_tsx,req.user.id); audit(req.user.id,"TSX",m.reward_tsx,"mission",m.code);
 }
 res.json({missions:db.prepare(`SELECT m.*,um.completed_at FROM missions m LEFT JOIN user_missions um ON um.mission_id=m.id AND um.user_id=?`).all(req.user.id)});
});
app.get("/api/market",auth,(req,res)=>{
 const rows=db.prepare(`SELECT l.*,u.username seller FROM listings l JOIN users u ON u.id=l.seller_id WHERE l.status='open' ORDER BY l.id DESC`).all();
 res.json(rows);
});
app.post("/api/market/list",auth,(req,res)=>{
 const asset=String(req.body.asset||"TSX").toUpperCase(), quantity=Number(req.body.quantity), price=Number(req.body.price);
 if(!["TSX","USDT"].includes(asset)||quantity<=0||price<=0) return res.status(400).json({error:"Datos inválidos"});
 const w=wallet(req.user.id); if(w[asset.toLowerCase()]<quantity) return res.status(400).json({error:"Saldo insuficiente"});
 db.prepare(`UPDATE wallets SET ${asset.toLowerCase()}=${asset.toLowerCase()}-? WHERE user_id=?`).run(quantity,req.user.id);
 db.prepare("INSERT INTO listings(seller_id,asset,quantity,price) VALUES(?,?,?,?)").run(req.user.id,asset,quantity,price);
 audit(req.user.id,asset,-quantity,"market_lock","listing");
 res.json({ok:true});
});
app.post("/api/market/buy/:id",auth,(req,res)=>{
 const listing=db.prepare("SELECT * FROM listings WHERE id=? AND status='open'").get(req.params.id);
 if(!listing||listing.seller_id===req.user.id) return res.status(404).json({error:"Oferta no disponible"});
 const buyer=wallet(req.user.id), total=listing.quantity*listing.price, fee=total*FEE/100;
 if(buyer.usdt<total+fee) return res.status(400).json({error:"USDT insuficiente"});
 const tx=db.transaction(()=>{
  db.prepare("UPDATE wallets SET usdt=usdt-? WHERE user_id=?").run(total+fee,req.user.id);
  db.prepare(`UPDATE wallets SET ${listing.asset.toLowerCase()}=${listing.asset.toLowerCase()}+? WHERE user_id=?`).run(listing.quantity,req.user.id);
  db.prepare("UPDATE wallets SET usdt=usdt+? WHERE user_id=?").run(total,listing.seller_id);
  db.prepare("UPDATE listings SET status='filled' WHERE id=?").run(listing.id);
  audit(req.user.id,"USDT",-total-fee,"market_buy",String(listing.id));
  audit(req.user.id,listing.asset,listing.quantity,"market_receive",String(listing.id));
  audit(listing.seller_id,"USDT",total,"market_sale",String(listing.id));
 }); tx();
 res.json({ok:true,fee});
});
app.get("/api/ledger",auth,(req,res)=>res.json(db.prepare("SELECT * FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 50").all(req.user.id)));
app.get("/api/admin/stats",auth,(req,res)=>{
 if(!["admin","super_admin"].includes(req.user.role)) return res.status(403).json({error:"Solo admin"});
 res.json({
  users:db.prepare("SELECT COUNT(*) c FROM users").get().c,
  planets:db.prepare("SELECT COUNT(*) c FROM planets").get().c,
  listings:db.prepare("SELECT COUNT(*) c FROM listings WHERE status='open'").get().c,
  ledger:db.prepare("SELECT COUNT(*) c FROM ledger").get().c
 });
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`TrendShopX GameFi V1 running on :${PORT}`));
