import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import { PrismaClient, Asset, LedgerType, ListingStatus, Role, FleetStatus, ResearchType, ShipType, NotificationType, BlockchainProvider } from "@prisma/client";
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
const ORIGIN=process.env.WEB_ORIGIN?.split(",")||true;
app.use(cors({origin:ORIGIN}));
app.use(express.json({limit:"200kb"}));
app.use(rateLimit({windowMs:60_000,max:Number(process.env.RATE_LIMIT||120),standardHeaders:true,legacyHeaders:false}));

type Token={id:number,username:string,role:Role};
function sign(u:Token){return jwt.sign(u,SECRET,{expiresIn:"7d"});}
function auth(req:express.Request,res:express.Response,next:express.NextFunction){
 const h=req.headers.authorization||"";
 if(!h.startsWith("Bearer ")) return res.status(401).json({error:"No autenticado"});
 try{(req as any).user=jwt.verify(h.slice(7),SECRET) as Token;next()}catch{return res.status(401).json({error:"Token inválido"});}
}
function num(v:any,min=0){const n=Number(v);return Number.isFinite(n)&&n>=min?n:null;}
function cost(level:number,type:string){const b:any={metalMine:[120,70,0],crystalMine:[180,110,0],deutSynth:[225,160,20],powerPlant:[90,70,0]}[type];const f=Math.pow(1.55,Math.max(0,level-1));return {metal:Math.ceil(b[0]*f),crystal:Math.ceil(b[1]*f),deuterium:Math.ceil(b[2]*f)}}
const shipStats:any={MINER:{attack:4,defense:12,speed:80},FIGHTER:{attack:20,defense:10,speed:180},CRUISER:{attack:45,defense:30,speed:140},TRANSPORT:{attack:2,defense:18,speed:100},EXPLORER:{attack:12,defense:15,speed:220}};
const shipCost:any={MINER:{metal:500,crystal:250,deuterium:0},FIGHTER:{metal:1000,crystal:500,deuterium:100},CRUISER:{metal:3000,crystal:1500,deuterium:500},TRANSPORT:{metal:2000,crystal:1000,deuterium:100},EXPLORER:{metal:1500,crystal:1200,deuterium:400}};

async function tickPlanet(id:number){
 const p=await prisma.planet.findUnique({where:{id}}); if(!p)return null;
 const now=new Date(),ms=Math.max(0,Math.min(now.getTime()-p.lastTick.getTime(),86400000)),h=ms/3600000;
 if(ms<1000)return p;
 return prisma.planet.update({where:{id},data:{
  metal:{increment:30*p.metalMine*Math.pow(1.15,p.metalMine-1)*h},
  crystal:{increment:20*p.crystalMine*Math.pow(1.15,p.crystalMine-1)*h},
  deuterium:{increment:8*p.deutSynth*Math.pow(1.15,p.deutSynth-1)*h},
  energy:{increment:0},lastTick:now
 }});
}
async function tickUser(userId:number){const ps=await prisma.planet.findMany({where:{userId}});return Promise.all(ps.map(p=>tickPlanet(p.id)));}
async function addLedger(tx:any,userId:number,asset:Asset,amount:number,type:LedgerType,reference?:string){return tx.ledger.create({data:{userId,asset,amount,type,reference}});}
async function notify(userId:number,type:NotificationType,title:string,message:string){
 const n=await prisma.notification.create({data:{userId,type,title,message}});
 const payload=JSON.stringify({type:"notification",data:n});
 wss.clients.forEach(c=>{if(c.readyState===1)c.send(payload)});
 return n;
}
async function audit(userId:number|undefined,action:string,entity:string,entityId?:string,metadata?:any){return prisma.auditLog.create({data:{userId,action,entity,entityId,metadata}});}
async function idem(req:any,res:any,next:any){
 const key=String(req.headers["idempotency-key"]||""); if(!key)return next();
 const u=req.user as Token; const old=await prisma.idempotencyKey.findUnique({where:{userId_key:{userId:u.id,key}}}); if(old)return res.json(old.response);
 (req as any).idempotencyKey=key; next();
}
app.get("/health",async(_,res)=>res.json({ok:true,service:"trendshopx-gamefi-api",version:"2.0.0",time:new Date().toISOString()}));

app.post("/auth/register",async(req,res)=>{
 const username=String(req.body.username||"").trim().toLowerCase(),password=String(req.body.password||"");
 if(!/^[a-z0-9_]{3,20}$/.test(username)||password.length<6)return res.status(400).json({error:"Usuario 3-20 y contraseña mínima de 6."});
 try{
  const hash=await bcrypt.hash(password,12);
  const result=await prisma.$transaction(async tx=>{
   const position=await freePosition(tx);
   const u=await tx.user.create({data:{username,passwordHash:hash},select:{id:true,username:true,role:true}});
   const p=await tx.planet.create({data:{userId:u.id,name:username+"'s World",galaxy:1,system:1,position}});
   await tx.wallet.create({data:{userId:u.id,tsx:1000}});
   await tx.ledger.create({data:{userId:u.id,asset:Asset.TSX,amount:1000,type:LedgerType.BONUS,reference:"welcome"}});
   for(const type of Object.values(ResearchType)) await tx.research.create({data:{userId:u.id,planetId:p.id,type,level:1}});
   return u;
  });
  res.json({token:sign(result as Token),user:result});
 }catch(e){res.status(409).json({error:"No se pudo crear la cuenta; prueba otro usuario."});}
});
async function freePosition(tx:any){const used=await tx.planet.findMany({where:{galaxy:1,system:1},select:{position:true}});const set=new Set(used.map((x:any)=>x.position));for(let i=1;i<=15;i++)if(!set.has(i))return i;return Math.floor(Math.random()*1000)+100;}

app.post("/auth/login",async(req,res)=>{
 const u=await prisma.user.findUnique({where:{username:String(req.body.username||"").trim().toLowerCase()}});
 if(!u||!(await bcrypt.compare(String(req.body.password||""),u.passwordHash)))return res.status(401).json({error:"Credenciales incorrectas"});
 res.json({token:sign({id:u.id,username:u.username,role:u.role}),user:{id:u.id,username:u.username,role:u.role}});
});

app.get("/me",auth,async(req,res)=>{
 const u=(req as any).user as Token;const ps=await tickUser(u.id),w=await prisma.wallet.findUnique({where:{userId:u.id}});const ships=await prisma.ship.findMany({where:{userId:u.id}});const alliance=await prisma.allianceMember.findUnique({where:{userId:u.id},include:{alliance:true}});
 res.json({user:u,planets:ps,wallet:w,ships,alliance:alliance?.alliance||null,marketFee:FEE});
});
app.get("/planets",auth,async(req,res)=>res.json(await tickUser((req as any).user.id)));
app.post("/planets",auth,async(req,res)=>{
 const u=(req as any).user as Token;const name=String(req.body.name||"Colonia"),pos=await freePosition(prisma);
 const p=await prisma.planet.create({data:{userId:u.id,name,galaxy:1,system:1,position:pos}});
 res.json(p);
});
app.post("/planets/:id/select",auth,async(req,res)=>{
 const u=(req as any).user as Token;const id=Number(req.params.id);const p=await prisma.planet.findFirst({where:{id,userId:u.id}});if(!p)return res.status(404).json({error:"Planeta no encontrado"});res.json(await tickPlanet(id));
});

app.post("/build/upgrade",auth,idem,async(req,res)=>{
 const u=(req as any).user as Token,type=String(req.body.type||""),planetId=Number(req.body.planetId);
 if(!["metalMine","crystalMine","deutSynth","powerPlant"].includes(type))return res.status(400).json({error:"Edificio inválido"});
 const p=await prisma.planet.findFirst({where:{id:planetId,userId:u.id}});if(!p)return res.status(404).json({error:"Planeta no encontrado"});
 await tickPlanet(p.id);const fresh=await prisma.planet.findUnique({where:{id:p.id}}) as any;const level=fresh[type],c=cost(level,type);
 if(fresh.metal<c.metal||fresh.crystal<c.crystal||fresh.deuterium<c.deuterium)return res.status(400).json({error:"Recursos insuficientes",cost:c});
 const updated=await prisma.$transaction(async tx=>{
  const out=await tx.planet.update({where:{id:p.id},data:{metal:{decrement:c.metal},crystal:{decrement:c.crystal},deuterium:{decrement:c.deuterium},[type]:{increment:1}}});
  await addLedger(tx,u.id,Asset.TSX,0,LedgerType.BUILD,type+"+"+level);return out;
 });await audit(u.id,"BUILD_UPGRADE","Planet",String(p.id),{type,level});
 res.json({planet:updated,cost:c});
});

app.get("/research",auth,async(req,res)=>{
 const u=(req as any).user as Token;res.json(await prisma.research.findMany({where:{userId:u.id},include:{planet:true}}));
});
app.post("/research/upgrade",auth,idem,async(req,res)=>{
 const u=(req as any).user as Token,type=String(req.body.type||"") as ResearchType,planetId=Number(req.body.planetId);
 if(!Object.values(ResearchType).includes(type))return res.status(400).json({error:"Investigación inválida"});
 const r=await prisma.research.findUnique({where:{userId_type:{userId:u.id,type}}});const p=await prisma.planet.findFirst({where:{id:planetId,userId:u.id}});if(!r||!p)return res.status(404).json({error:"Datos no encontrados"});
 await tickPlanet(p.id);const f=await prisma.planet.findUnique({where:{id:p.id}}) as any;const c={metal:Math.ceil(800*Math.pow(1.8,r.level-1)),crystal:Math.ceil(500*Math.pow(1.7,r.level-1)),deuterium:Math.ceil(200*Math.pow(1.6,r.level-1))};
 if(f.metal<c.metal||f.crystal<c.crystal||f.deuterium<c.deuterium)return res.status(400).json({error:"Recursos insuficientes",cost:c});
 const out=await prisma.$transaction(async tx=>{await tx.planet.update({where:{id:p.id},data:{metal:{decrement:c.metal},crystal:{decrement:c.crystal},deuterium:{decrement:c.deuterium}}});return tx.research.update({where:{id:r.id},data:{level:{increment:1}}})});
 res.json({research:out,cost:c});
});

app.get("/ships",auth,async(req,res)=>res.json(await prisma.ship.findMany({where:{userId:(req as any).user.id}})));
app.post("/ships/build",auth,idem,async(req,res)=>{
 const u=(req as any).user as Token,type=String(req.body.type||"") as ShipType,q=num(req.body.quantity,1);
 if(!q||!Object.values(ShipType).includes(type))return res.status(400).json({error:"Nave/cantidad inválida"});const p=await prisma.planet.findFirst({where:{id:Number(req.body.planetId),userId:u.id}});if(!p)return res.status(404).json({error:"Planeta no encontrado"});
 await tickPlanet(p.id);const c=shipCost[type],total={metal:c.metal*q,crystal:c.crystal*q,deuterium:c.deuterium*q},f=await prisma.planet.findUnique({where:{id:p.id}}) as any;
 if(f.metal<total.metal||f.crystal<total.crystal||f.deuterium<total.deuterium)return res.status(400).json({error:"Recursos insuficientes",cost:total});
 const s=await prisma.$transaction(async tx=>{await tx.planet.update({where:{id:p.id},data:{metal:{decrement:total.metal},crystal:{decrement:total.crystal},deuterium:{decrement:total.deuterium}}});return tx.ship.upsert({where:{userId_type:{userId:u.id,type}},update:{quantity:{increment:q}},create:{userId:u.id,type,quantity:q}})});
 res.json({ship:s,cost:total});
});

app.get("/market",auth,async(_,res)=>res.json(await prisma.listing.findMany({where:{status:ListingStatus.OPEN,asset:Asset.TSX},include:{seller:{select:{username:true}}},orderBy:{id:"desc"}})));
app.post("/market/list",auth,idem,async(req,res)=>{
 const u=(req as any).user as Token,q=num(req.body.quantity),price=num(req.body.price);
 if(!q||!price)return res.status(400).json({error:"Cantidad y precio inválidos"});const w=await prisma.wallet.findUnique({where:{userId:u.id}});if(!w||w.tsx<q)return res.status(400).json({error:"Saldo TSX insuficiente"});
 const l=await prisma.$transaction(async tx=>{await tx.wallet.update({where:{userId:u.id},data:{tsx:{decrement:q},lockedTsx:{increment:q}}});return tx.listing.create({data:{sellerId:u.id,asset:Asset.TSX,quantity:q,price}})});
 await audit(u.id,"MARKET_LIST","Listing",String(l.id),{q,price});res.json(l);
});
app.post("/market/buy/:id",auth,idem,async(req,res)=>{
 const u=(req as any).user as Token,id=Number(req.params.id),l=await prisma.listing.findUnique({where:{id}});
 if(!l||l.status!==ListingStatus.OPEN||l.sellerId===u.id||l.asset!==Asset.TSX)return res.status(404).json({error:"Oferta no disponible"});
 const total=l.quantity*l.price,fee=total*FEE/100,b=await prisma.wallet.findUnique({where:{userId:u.id}});
 if(!b||b.usdt<total+fee)return res.status(400).json({error:"USDT insuficiente"});
 await prisma.$transaction(async tx=>{
  await tx.wallet.update({where:{userId:u.id},data:{usdt:{decrement:total+fee},tsx:{increment:l.quantity}}});
  await tx.wallet.update({where:{userId:l.sellerId},data:{usdt:{increment:total},lockedTsx:{decrement:l.quantity}}});
  await tx.listing.update({where:{id},data:{status:ListingStatus.FILLED,filledAt:new Date()}});
  await addLedger(tx,u.id,Asset.USDT,-total-fee,LedgerType.MARKET_BUY,String(id));
  await addLedger(tx,u.id,Asset.TSX,l.quantity,LedgerType.MARKET_BUY,String(id));
  await addLedger(tx,l.sellerId,Asset.USDT,total,LedgerType.MARKET_SELL,String(id));
  await addLedger(tx,l.sellerId,Asset.TSX,-l.quantity,LedgerType.MARKET_SELL,String(id));
  if(fee) await addLedger(tx,u.id,Asset.USDT,-fee,LedgerType.MARKET_FEE,String(id));
 });
 await notify(l.sellerId,NotificationType.MARKET,"Venta completada",`Vendiste ${l.quantity} TSX por ${total} USDT.`);
 res.json({ok:true,total,fee});
});
app.delete("/market/:id",auth,async(req,res)=>{
 const u=(req as any).user as Token,id=Number(req.params.id),l=await prisma.listing.findFirst({where:{id,sellerId:u.id,status:ListingStatus.OPEN}});if(!l)return res.status(404).json({error:"Oferta no encontrada"});
 await prisma.$transaction(async tx=>{await tx.wallet.update({where:{userId:u.id},data:{tsx:{increment:l.quantity},lockedTsx:{decrement:l.quantity}}});await tx.listing.update({where:{id},data:{status:ListingStatus.CANCELLED}});});
 res.json({ok:true});
});

app.get("/wallet/ledger",auth,async(req,res)=>res.json(await prisma.ledger.findMany({where:{userId:(req as any).user.id},orderBy:{id:"desc"},take:100})));
app.get("/notifications",auth,async(req,res)=>res.json(await prisma.notification.findMany({where:{userId:(req as any).user.id},orderBy:{id:"desc"},take:50})));
app.post("/notifications/:id/read",auth,async(req,res)=>res.json(await prisma.notification.updateMany({where:{id:Number(req.params.id),userId:(req as any).user.id},data:{read:true}})));

app.get("/missions",auth,async(req,res)=>res.json(await prisma.mission.findMany({include:{users:{where:{userId:(req as any).user.id}}}})));
app.post("/missions/check",auth,async(req,res)=>{
 const u=(req as any).user as Token,ps=await tickUser(u.id);const p=ps[0];if(!p)return res.status(404).end();const ms=await prisma.mission.findMany();
 for(const m of ms){const ok=m.code==="rich_planet"&&p.metal>=5000;if(ok){const um=await prisma.userMission.findUnique({where:{userId_missionId:{userId:u.id,missionId:m.id}}});if(!um||um.status!== "COMPLETED"){await prisma.$transaction(async tx=>{await tx.userMission.upsert({where:{userId_missionId:{userId:u.id,missionId:m.id}},update:{status:"COMPLETED",completedAt:new Date()},create:{userId:u.id,missionId:m.id,status:"COMPLETED",completedAt:new Date()}});await tx.wallet.update({where:{userId:u.id},data:{tsx:{increment:m.rewardTsx}}});if(m.rewardTsx)await addLedger(tx,u.id,Asset.TSX,m.rewardTsx,LedgerType.MISSION,m.code);});await notify(u.id,NotificationType.MISSION,"Misión completada",m.title);}}}
 res.json({ok:true});
});

app.get("/fleets",auth,async(req,res)=>{const u=(req as any).user as Token;await completeArrivals(u.id);res.json(await prisma.fleet.findMany({where:{userId:u.id},orderBy:{id:"desc"}}))});
async function completeArrivals(userId:number){const now=new Date();const fs=await prisma.fleet.findMany({where:{userId,status:FleetStatus.TRAVELING,arrivalAt:{lte:now}}});for(const f of fs)await prisma.fleet.update({where:{id:f.id},data:{status:FleetStatus.IDLE}});}
app.post("/fleets/dispatch",auth,async(req,res)=>{
 const u=(req as any).user as Token,from=Number(req.body.planetId),to=Number(req.body.destinationPlanetId),minutes=Math.max(1,Math.floor(Number(req.body.minutes)||5));
 const p=await prisma.planet.findFirst({where:{id:from,userId:u.id}}),d=await prisma.planet.findUnique({where:{id:to}});if(!p||!d||p.id===d.id)return res.status(400).json({error:"Ruta inválida"});
 const ships=await prisma.ship.findMany({where:{userId:u.id}});const payload:any={};let attack=0,defense=0,speed=9999;
 for(const s of ships){if(s.quantity>0){payload[s.type]=s.quantity;attack+=s.quantity*shipStats[s.type].attack;defense+=s.quantity*shipStats[s.type].defense;speed=Math.min(speed,shipStats[s.type].speed)}}
 if(!Object.keys(payload).length)return res.status(400).json({error:"No tienes naves"});
 const departure=new Date(),arrival=new Date(departure.getTime()+minutes*60000);
 await prisma.fleet.create({data:{userId:u.id,planetId:from,name:String(req.body.name||"Expedición"),ships:payload,attack,defense,speed,status:FleetStatus.TRAVELING,destinationPlanetId:to,departureAt:departure,arrivalAt:arrival}});
 res.json({ok:true,arrivalAt:arrival});
});

app.post("/battle/:defenderId",auth,async(req,res)=>{
 const u=(req as any).user as Token,did=Number(req.params.defenderId);if(did===u.id)return res.status(400).json({error:"No puedes atacarte"});
 const af=await prisma.fleet.findFirst({where:{userId:u.id,status:FleetStatus.IDLE}}),df=await prisma.fleet.findFirst({where:{userId:did,status:FleetStatus.IDLE}});if(!af||!df)return res.status(400).json({error:"Ambos jugadores necesitan una flota IDLE"});
 const ap=af.attack+Math.floor(Math.random()*Math.max(5,af.defense)),dp=df.attack+Math.floor(Math.random()*Math.max(5,df.defense)),winner=ap>=dp?u.id:did;
 const aLoss=Math.min(af.attack,Math.floor(af.attack*(dp/(ap+dp))*0.35)),dLoss=Math.min(df.attack,Math.floor(df.attack*(ap/(ap+dp))*0.35));
 const report=await prisma.battleReport.create({data:{attackerId:u.id,defenderId:did,winnerId:winner,attackerPower:ap,defenderPower:dp,attackerLosses:{power:aLoss},defenderLosses:{power:dLoss}}});
 await prisma.fleet.update({where:{id:af.id},data:{status:FleetStatus.RETURNING}});await prisma.fleet.update({where:{id:df.id},data:{status:FleetStatus.IDLE}});
 await notify(u.id,NotificationType.BATTLE,"Informe de batalla",`Combate resuelto contra el comandante ${did}.`);
 await notify(did,NotificationType.BATTLE,"Has sido atacado",`Tu defensa recibió un ataque del comandante ${u.id}.`);
 res.json(report);
});

app.get("/alliances",async(_,res)=>res.json(await prisma.alliance.findMany({include:{members:{include:{user:{select:{username:true}}}}})));
app.post("/alliances",auth,async(req,res)=>{const u=(req as any).user as Token;const name=String(req.body.name||"").trim(),tag=String(req.body.tag||"").trim().toUpperCase();if(name.length<3||tag.length<2||tag.length>6)return res.status(400).json({error:"Nombre/tag inválidos"});try{const a=await prisma.$transaction(async tx=>{const a=await tx.alliance.create({data:{name,tag}});await tx.allianceMember.create({data:{allianceId:a.id,userId:u.id}});return a});res.json(a)}catch{return res.status(409).json({error:"Nombre o tag ya usado"})}});
app.post("/alliances/:id/join",auth,async(req,res)=>{const u=(req as any).user as Token,id=Number(req.params.id);if(await prisma.allianceMember.findUnique({where:{userId:u.id}}))return res.status(409).json({error:"Ya perteneces a una alianza"});res.json(await prisma.allianceMember.create({data:{allianceId:id,userId:u.id}}))});
app.post("/alliances/leave",auth,async(req,res)=>{const u=(req as any).user as Token;await prisma.allianceMember.delete({where:{userId:u.id}}).catch(()=>{});res.json({ok:true})});

app.get("/ranking",async(_,res)=>res.json(await prisma.planet.findMany({orderBy:[{metal:"desc"},{crystal:"desc"}],take:50,include:{user:{select:{username:true}}}})));
app.get("/admin/stats",auth,async(req,res)=>{const u=(req as any).user as Token;if(![Role.ADMIN,Role.SUPER_ADMIN].includes(u.role))return res.status(403).json({error:"Solo admin"});res.json({users:await prisma.user.count(),planets:await prisma.planet.count(),listings:await prisma.listing.count({where:{status:"OPEN"}}),ledger:await prisma.ledger.count(),fleets:await prisma.fleet.count(),battles:await prisma.battleReport.count(),alliances:await prisma.alliance.count(),notifications:await prisma.notification.count()})});
app.get("/admin/audit",auth,async(req,res)=>{const u=(req as any).user as Token;if(![Role.ADMIN,Role.SUPER_ADMIN].includes(u.role))return res.status(403).json({error:"Solo admin"});res.json(await prisma.auditLog.findMany({orderBy:{id:"desc"},take:100,include:{user:{select:{username:true}}}}))});

app.post("/web3/simulate/deposit",auth,async(req,res)=>{
 const u=(req as any).user as Token,amount=num(req.body.amount),asset=String(req.body.asset||"USDT") as Asset;if(!amount||!Object.values(Asset).includes(asset))return res.status(400).json({error:"Datos inválidos"});
 const txHash="sim_"+Date.now()+"_"+Math.random().toString(36).slice(2);const out=await prisma.$transaction(async tx=>{await tx.wallet.update({where:{userId:u.id},data:{[asset==="TSX"?"tsx":"usdt"]:{increment:amount}}});await tx.ledger.create({data:{userId:u.id,asset,amount,type:LedgerType.DEPOSIT,reference:txHash}});return tx.chainTransaction.create({data:{userId:u.id,provider:BlockchainProvider.SIMULATED_EVM,asset,direction:"DEPOSIT",txHash,amount}})});res.json({mode:"SIMULATED",transaction:out,message:"Simulación local; no es una transferencia blockchain real."});
});
app.post("/web3/simulate/withdraw",auth,async(req,res)=>{
 const u=(req as any).user as Token,amount=num(req.body.amount),asset=String(req.body.asset||"USDT") as Asset;if(!amount||!Object.values(Asset).includes(asset))return res.status(400).json({error:"Datos inválidos"});const field=asset==="TSX"?"tsx":"usdt";const w=await prisma.wallet.findUnique({where:{userId:u.id}});if(!w||((w as any)[field]<amount))return res.status(400).json({error:"Saldo insuficiente"});
 const txHash="sim_"+Date.now()+"_"+Math.random().toString(36).slice(2);const out=await prisma.$transaction(async tx=>{await tx.wallet.update({where:{userId:u.id},data:{[field]:{decrement:amount}}});await tx.ledger.create({data:{userId:u.id,asset,amount:-amount,type:LedgerType.WITHDRAW,reference:txHash}});return tx.chainTransaction.create({data:{userId:u.id,provider:BlockchainProvider.SIMULATED_EVM,asset,direction:"WITHDRAW",txHash,amount}})});res.json({mode:"SIMULATED",transaction:out,message:"Simulación local; sustituye este adaptador por un proveedor RPC antes de usar fondos reales."});
});

wss.on("connection",ws=>ws.send(JSON.stringify({type:"connected",service:"gamefi",version:"2.0.0"})));
process.on("SIGINT",async()=>{await prisma.$disconnect();process.exit(0)});
http.listen(PORT,()=>console.log("TrendShopX GameFi API v2 listening on "+PORT));
