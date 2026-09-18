import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { PrismaClient, Asset, LedgerType, ListingStatus, Role } from "@prisma/client";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

dotenv.config();
const prisma=new PrismaClient();
const app=express();
const http=createServer(app);
const wss=new WebSocketServer({server:http,path:"/ws"});
const PORT=Number(process.env.API_PORT||4000);
const SECRET=process.env.JWT_SECRET||"dev-secret";
const FEE=Number(process.env.MARKET_FEE_PERCENT||3);
app.use(cors({origin:process.env.WEB_ORIGIN?.split(",")||true}));
app.use(express.json());

type Token={id:number,username:string,role:Role};
function sign(u:Token){return jwt.sign(u,SECRET,{expiresIn:"7d"});}
function auth(req:express.Request,res:express.Response,next:express.NextFunction){
 const h=req.headers.authorization||"";
 if(!h.startsWith("Bearer ")) return res.status(401).json({error:"No autenticado"});
 try{(req as any).user=jwt.verify(h.slice(7),SECRET) as Token;next()}catch{return res.status(401).json({error:"Token inválido"});}
}
function cost(level:number,type:string){const b:any={metalMine:[120,70,0],crystalMine:[180,110,0],deutSynth:[225,160,20],powerPlant:[90,70,0]}[type];const f=Math.pow(1.55,level-1);return {metal:Math.ceil(b[0]*f),crystal:Math.ceil(b[1]*f),deuterium:Math.ceil(b[2]*f)}}
async function tick(userId:number){
 const p=await prisma.planet.findUnique({where:{userId}});
 if(!p)return null;
 const now=new Date(), ms=Math.max(0,Math.min(now.getTime()-p.lastTick.getTime(),86400000)),h=ms/3600000;
 const gains={metal:30*p.metalMine*Math.pow(1.15,p.metalMine-1)*h,crystal:20*p.crystalMine*Math.pow(1.15,p.crystalMine-1)*h,deuterium:8*p.deutSynth*Math.pow(1.15,p.deutSynth-1)*h};
 return prisma.planet.update({where:{id:p.id},data:{...gains,lastTick:now}});
}
async function ledger(userId:number,asset:Asset,amount:number,type:LedgerType,reference?:string){await prisma.ledger.create({data:{userId,asset,amount,type,reference}})}
app.get("/health",(_,res)=>res.json({ok:true,service:"trendshopx-gamefi-api",version:"1.0.0"}));

app.post("/auth/register",async(req,res)=>{
 const username=String(req.body.username||"").trim().toLowerCase(),password=String(req.body.password||"");
 if(!/^[a-z0-9_]{3,20}$/.test(username)||password.length<6)return res.status(400).json({error:"Usuario 3-20 y contraseña mínima de 6."});
 try{
  const hash=await bcrypt.hash(password,12);
  const u=await prisma.user.create({data:{username,passwordHash:hash,planet:{create:{name:username+"'s World"}},wallet:{create:{tsx:1000}}},select:{id:true,username:true,role:true}});
  await ledger(u.id,Asset.TSX,1000,LedgerType.BONUS,"welcome");
  res.json({token:sign(u as Token),user:u});
 }catch{return res.status(409).json({error:"Usuario ya existe"});}
});
app.post("/auth/login",async(req,res)=>{
 const u=await prisma.user.findUnique({where:{username:String(req.body.username||"").trim().toLowerCase()}});
 if(!u||!(await bcrypt.compare(String(req.body.password||""),u.passwordHash)))return res.status(401).json({error:"Credenciales incorrectas"});
 res.json({token:sign({id:u.id,username:u.username,role:u.role}),user:{id:u.id,username:u.username,role:u.role}});
});
app.get("/me",auth,async(req,res)=>{const u=(req as any).user as Token;const p=await tick(u.id),w=await prisma.wallet.findUnique({where:{userId:u.id}});res.json({user:u,planet:p,wallet:w,marketFee:FEE});});

app.post("/build/upgrade",auth,async(req,res)=>{
 const u=(req as any).user as Token,type=String(req.body.type||"");if(!["metalMine","crystalMine","deutSynth","powerPlant"].includes(type))return res.status(400).json({error:"Edificio inválido"});
 const p=await tick(u.id),level=(p as any)[type] as number,c=cost(level,type);
 if(!p||p.metal<c.metal||p.crystal<c.crystal||p.deuterium<c.deuterium)return res.status(400).json({error:"Recursos insuficientes",cost:c});
 const updated=await prisma.planet.update({where:{id:p.id},data:{metal:{decrement:c.metal},crystal:{decrement:c.crystal},deuterium:{decrement:c.deuterium},[type]:{increment:1}}});
 res.json({planet:updated,cost:c});
});

app.get("/market",auth,async(_,res)=>res.json(await prisma.listing.findMany({where:{status:ListingStatus.OPEN},include:{seller:{select:{username:true}}},orderBy:{id:"desc"}})));
app.post("/market/list",auth,async(req,res)=>{
 const u=(req as any).user as Token,asset=String(req.body.asset||"TSX") as Asset,q=Number(req.body.quantity),price=Number(req.body.price);
 if(![Asset.TSX,Asset.USDT].includes(asset)||q<=0||price<=0)return res.status(400).json({error:"Datos inválidos"});
 const field=asset===Asset.TSX?"tsx":"usdt",w=await prisma.wallet.findUnique({where:{userId:u.id}});if(!w||((w as any)[field]<q))return res.status(400).json({error:"Saldo insuficiente"});
 const l=await prisma.$transaction(async tx=>{await tx.wallet.update({where:{userId:u.id},data:{[field]:{decrement:q},[asset==="TSX"?"lockedTsx":"lockedUsdt"]:{increment:q}}});return tx.listing.create({data:{sellerId:u.id,asset,quantity:q,price}})});
 await ledger(u.id,asset,-q,LedgerType.MARKET_SELL,String(l.id));res.json(l);
});
app.post("/market/buy/:id",auth,async(req,res)=>{
 const u=(req as any).user as Token,id=Number(req.params.id),l=await prisma.listing.findUnique({where:{id}});
 if(!l||l.status!==ListingStatus.OPEN||l.sellerId===u.id)return res.status(404).json({error:"Oferta no disponible"});
 const total=l.quantity*l.price,fee=total*FEE/100,b=await prisma.wallet.findUnique({where:{userId:u.id}});
 if(!b||b.usdt<total+fee)return res.status(400).json({error:"USDT insuficiente"});
 await prisma.$transaction(async tx=>{
  await tx.wallet.update({where:{userId:u.id},data:{usdt:{decrement:total+fee},[l.asset==="TSX"?"tsx":"usdt"]:{increment:l.quantity}}});
  await tx.wallet.update({where:{userId:l.sellerId},data:{usdt:{increment:total},[l.asset==="TSX"?"lockedTsx":"lockedUsdt"]:{decrement:l.quantity}}});
  await tx.listing.update({where:{id},data:{status:ListingStatus.FILLED}});
 });
 await Promise.all([ledger(u.id,Asset.USDT,-total-fee,LedgerType.MARKET_BUY,String(id)),ledger(u.id,l.asset,l.quantity,LedgerType.REWARD,String(id)),ledger(l.sellerId,Asset.USDT,total,LedgerType.MARKET_SELL,String(id))]);
 res.json({ok:true,fee});
});

app.get("/wallet/ledger",auth,async(req,res)=>{const u=(req as any).user as Token;res.json(await prisma.ledger.findMany({where:{userId:u.id},orderBy:{id:"desc"},take:100}))});
app.get("/missions",auth,async(req,res)=>{const u=(req as any).user as Token;res.json(await prisma.mission.findMany({include:{users:{where:{userId:u.id}}}}))});
app.post("/missions/check",auth,async(req,res)=>{
 const u=(req as any).user as Token,p=await tick(u.id);if(!p)return res.status(404).end();
 const ms=await prisma.mission.findMany();for(const m of ms){let ok=m.code==="rich_planet"&&p.metal>=5000;if(ok&&!await prisma.userMission.findUnique({where:{userId_missionId:{userId:u.id,missionId:m.id}}})){await prisma.userMission.create({data:{userId:u.id,missionId:m.id,completedAt:new Date()}});await prisma.wallet.update({where:{userId:u.id},data:{tsx:{increment:m.rewardTsx}}});if(m.rewardTsx)await ledger(u.id,Asset.TSX,m.rewardTsx,LedgerType.MISSION,m.code)}}res.json({ok:true});
});
app.get("/ranking",async(_,res)=>res.json(await prisma.planet.findMany({orderBy:{metal:"desc"},take:50,include:{user:{select:{username:true}}})));
app.get("/fleets",auth,async(req,res)=>{const u=(req as any).user as Token;res.json(await prisma.fleet.findMany({where:{userId:u.id}}))});
app.post("/fleets",auth,async(req,res)=>{const u=(req as any).user as Token;const ships=Math.max(1,Math.floor(Number(req.body.ships)||1));res.json(await prisma.fleet.create({data:{userId:u.id,name:String(req.body.name||"Flota "+Date.now()),ships,attack:ships*10,defense:ships*10}}))});
app.post("/battle/:defenderId",auth,async(req,res)=>{
 const u=(req as any).user as Token,did=Number(req.params.defenderId);if(did===u.id)return res.status(400).json({error:"No puedes atacarte"});
 const af=await prisma.fleet.findFirst({where:{userId:u.id,status:"IDLE"}}),df=await prisma.fleet.findFirst({where:{userId:did,status:"IDLE"}});if(!af||!df)return res.status(400).json({error:"Ambos jugadores necesitan una flota IDLE"});
 const ap=af.attack+Math.floor(Math.random()*20),dp=df.attack+Math.floor(Math.random()*20),winner=ap>=dp?u.id:did;
 const report=await prisma.battleReport.create({data:{attackerId:u.id,defenderId:did,winnerId:winner,attackerPower:ap,defenderPower:dp}});
 res.json(report);
});
app.get("/admin/stats",auth,async(req,res)=>{const u=(req as any).user as Token;if(![Role.ADMIN,Role.SUPER_ADMIN].includes(u.role))return res.status(403).json({error:"Solo admin"});res.json({users:await prisma.user.count(),listings:await prisma.listing.count({where:{status:"OPEN"}}),ledger:await prisma.ledger.count(),fleets:await prisma.fleet.count()})});
wss.on("connection",ws=>ws.send(JSON.stringify({type:"connected",service:"gamefi"})));
http.listen(PORT,()=>console.log("API listening on "+PORT));