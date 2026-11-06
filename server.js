const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.get('/health', (_, res) => res.json({ ok: true }));
const storage = multer.diskStorage({ destination: UPLOAD_DIR, filename: (_, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(5).toString('hex')}${path.extname(file.originalname).slice(0,10)}`) });
const upload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024 }, fileFilter: (_, file, cb) => cb(null, file.mimetype.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac)$/i.test(file.originalname)) });
app.post('/api/upload', upload.array('tracks', 100), (req, res) => {
  res.json({ tracks: (req.files || []).map(f => ({ id: crypto.randomUUID(), name: path.basename(f.originalname, path.extname(f.originalname)), url: `/uploads/${f.filename}` })) });
});
const rooms = new Map();
const code = () => crypto.randomBytes(3).toString('hex').toUpperCase();
function publicState(room) {
  return { code: room.code, title: room.title, status: room.status, round: room.round, duration: room.duration, trackCount: room.tracks.length, currentTrack: room.revealed && room.currentTrack >= 0 ? room.tracks[room.currentTrack]?.name : null, participants: [...room.participants.values()].map(p => ({ id:p.id, name:p.name, score:p.score, online:p.online })), answers: room.answers.map(a => ({ name: room.participants.get(a.playerId)?.name || 'Участник', text: a.text, correct: a.correct, round: a.round })), board: room.board };
}
function broadcast(room) { io.to(room.code).emit('state', publicState(room)); }
function roomFor(socket) { return rooms.get(socket.data.room); }
io.on('connection', socket => {
  socket.on('room:create', ({ title, duration } = {}, cb = () => {}) => {
    let id; do { id = code(); } while (rooms.has(id));
    const room = { code:id, title:(title || 'Музыкальное лото').slice(0,60), host:socket.id, status:'lobby', duration:Math.max(10,Math.min(60,Number(duration)||20)), tracks:[], order:[], round:0, currentTrack:-1, revealed:false, participants:new Map(), answers:[], board:Array(25).fill('pending') };
    rooms.set(id, room); socket.join(id); socket.data.room=id; socket.data.role='host'; cb({ ok:true, code:id, state:publicState(room) }); broadcast(room);
  });
  socket.on('room:join', ({ code:raw, name } = {}, cb = () => {}) => {
    const id=String(raw||'').toUpperCase().trim(), room=rooms.get(id);
    if(!room) return cb({ok:false,error:'Комната не найдена'});
    const playerName=String(name||'').trim().slice(0,24); if(!playerName) return cb({ok:false,error:'Введите имя'});
    const player={id:socket.id,name:playerName,score:0,online:true}; room.participants.set(socket.id,player); socket.join(id); socket.data.room=id; socket.data.role='player'; cb({ok:true,code:id,state:publicState(room)}); broadcast(room);
  });
  socket.on('host:tracks', ({ tracks } = {}, cb=()=>{}) => { const r=roomFor(socket); if(!r||r.host!==socket.id)return cb({ok:false}); r.tracks=Array.isArray(tracks)?tracks.slice(0,100):[]; r.order=r.tracks.map((_,i)=>i).sort(()=>Math.random()-.5); r.board=Array(25).fill('pending'); cb({ok:true}); broadcast(r); });
  socket.on('host:start', (_,cb=()=>{}) => { const r=roomFor(socket); if(!r||r.host!==socket.id)return cb({ok:false}); if(!r.tracks.length)return cb({ok:false,error:'Сначала загрузите музыкальные треки'}); r.status='playing'; r.round=0; r.answers=[]; r.board=Array(25).fill('pending'); r.revealed=false; cb({ok:true}); broadcast(r); });
  socket.on('host:next', (_,cb=()=>{}) => { const r=roomFor(socket); if(!r||r.host!==socket.id)return cb({ok:false}); if(!r.tracks.length)return cb({ok:false,error:'Нет треков'}); if(r.round>=r.order.length)return cb({ok:false,error:'Все треки сыграны'}); r.currentTrack=r.order[r.round]; r.round++; r.revealed=false; r.answers=[]; const track=r.tracks[r.currentTrack]; r.board[r.round-1]='played'; cb({ok:true,track:{...track},round:r.round,duration:r.duration}); io.to(r.code).emit('round:start',{round:r.round,duration:r.duration, audioUrl:track?.url || null}); broadcast(r); });
  socket.on('host:reveal', (_,cb=()=>{}) => { const r=roomFor(socket); if(!r||r.host!==socket.id)return cb({ok:false}); r.revealed=true; const t=r.tracks[r.currentTrack]; io.to(r.code).emit('answer:revealed',{answer:t?.name||''}); broadcast(r); cb({ok:true}); });
  socket.on('host:mark', ({ round, correct } = {}, cb=()=>{}) => { const r=roomFor(socket); if(!r||r.host!==socket.id)return cb({ok:false}); const i=Number(round)-1; if(i<0||i>=25)return cb({ok:false}); r.board[i]=correct?'correct':'played'; broadcast(r); cb({ok:true}); });
  socket.on('player:answer', ({ text } = {}, cb=()=>{}) => { const r=roomFor(socket), p=r?.participants.get(socket.id); if(!r||!p||r.status!=='playing'||r.revealed||r.currentTrack<0)return cb({ok:false,error:'Сейчас ответы не принимаются'}); const value=String(text||'').trim().slice(0,120); if(!value)return cb({ok:false,error:'Введите ответ'}); if(r.answers.some(a=>a.playerId===socket.id))return cb({ok:false,error:'Вы уже отправили ответ в этом раунде'}); r.answers.push({playerId:socket.id,text:value,round:r.round,correct:false,at:Date.now()}); cb({ok:true}); broadcast(r); });
  socket.on('host:score', ({ playerId, points } = {}, cb=()=>{}) => { const r=roomFor(socket); if(!r||r.host!==socket.id)return cb({ok:false}); const p=r.participants.get(playerId); if(!p)return cb({ok:false}); p.score=Math.max(0,p.score+Math.max(-100,Math.min(100,Number(points)||0))); broadcast(r); cb({ok:true}); });
  socket.on('host:finish', (_,cb=()=>{}) => { const r=roomFor(socket); if(!r||r.host!==socket.id)return cb({ok:false}); r.status='finished'; broadcast(r); cb({ok:true}); });
  socket.on('disconnect',()=>{const r=roomFor(socket);if(!r)return;if(r.host===socket.id){io.to(r.code).emit('room:closed');rooms.delete(r.code);}else{const p=r.participants.get(socket.id);if(p)p.online=false;broadcast(r);}});
});
server.listen(PORT,()=>console.log(`Music Loto online: http://localhost:${PORT}`));
