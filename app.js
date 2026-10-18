const socket = io();
const $ = id => document.getElementById(id);
let state = null, currentAction = null, lastChatMode = "";
const roleHelp = {
  Guardian: "Pilih satu pemain lain untuk dilindungi malam ini. Kamu tidak bisa melindungi diri sendiri.",
  Seer: "Pilih satu pemain untuk memeriksa role aslinya. Hasilnya hanya kamu yang menerima.",
  Werewolf: "Pilih satu pemain untuk diserang malam ini. Chat malam khusus Werewolf.",
  Hunter: "Jika kamu tereliminasi karena voting, pilih satu pemain untuk ditembak.",
  "White Jack": "Pilih satu pemain untuk menebak apakah dia Werewolf. Benar: menang sendiri. Salah: kamu mati.",
  Villager: "Kamu tidak punya aksi malam khusus. Gunakan diskusi dan voting untuk membantu menemukan Werewolf."
};
function toast(msg){const el=$("toast");el.textContent=msg;el.style.display="block";setTimeout(()=>el.style.display="none",3000)}
function sendAck(event, data, onSuccess){socket.emit(event,data,res=>{if(res?.error)toast(res.error);else{if(res?.message)toast(res.message);if(onSuccess)onSuccess(res)}})}
function enterName(){return $("name").value.trim()}
$("create").onclick=()=>sendAck("createRoom",{name:enterName()},res=>{if(res.code)toast("Room dibuat: "+res.code)});
$("join").onclick=()=>sendAck("joinRoom",{name:enterName(),code:$("code").value},()=>toast("Berhasil masuk room."));
$("start").onclick=()=>sendAck("startGame",{});
$("leave").onclick=()=>{socket.emit("leaveRoom");$("game").classList.add("hidden");$("entry").classList.remove("hidden");state=null};
$("chatForm").onsubmit=e=>{e.preventDefault();const message=$("chatInput").value.trim();if(!message)return;sendAck("chat",{message},()=>{$("chatInput").value=""})};
function addMessage(text,system=false){const d=document.createElement("div");d.className="msg"+(system?" system":"");d.textContent=text;$("messages").appendChild(d);$("messages").scrollTop=$("messages").scrollHeight}
socket.on("notice",msg=>addMessage(msg,true));
socket.on("privateMessage",msg=>addMessage("🔒 "+msg,true));
socket.on("chatMessage",msg=>{if(state?.phase==="night"&&msg.channel!=="wolf")return;addMessage(msg.name+": "+msg.message)});
socket.on("state",s=>{state=s;render()});
function render(){
  $("entry").classList.add("hidden");$("game").classList.remove("hidden");
  $("roomCode").textContent=state.code;
  $("phaseName").textContent=({lobby:"Lobby",night:"Malam",day:"Siang",hunter:"Hunter",ended:"Selesai"})[state.phase]||state.phase;
  $("phaseIcon").textContent=state.phase==="night"?"☾":state.phase==="day"?"☀":"✦";
  $("dayNum").textContent=state.started?"Hari ke-"+state.day:"Menunggu pemain";
  $("playerCount").textContent=state.players.length+" pemain";
  $("myRole").textContent=state.me?.role||"Belum dibagikan";
  $("roleHelp").textContent=roleHelp[state.me?.role]||"Tunggu host memulai permainan.";
  $("start").classList.toggle("hidden",!(state.hostId===socket.id&&!state.started));
  $("start").disabled=state.players.length<5;
  $("players").innerHTML="";
  state.players.forEach(p=>{const d=document.createElement("div");d.className="player"+(p.alive?"":" dead");const n=document.createElement("span");n.textContent=p.name+(p.id===socket.id?" (Kamu)":"");const tag=document.createElement("span");tag.className="tag";tag.textContent=!p.alive?"MATI":p.role||"HIDUP";d.append(n,tag);$("players").appendChild(d)});
  $("chatMode").textContent=state.phase==="night"?"Malam":state.phase==="day"?"Diskusi":state.phase==="ended"?"Selesai":"Lobby";
  const canChat=state.started&&!state.ended&&state.me?.alive&&(state.phase==="day"||(state.phase==="night"&&state.me.role==="Werewolf"));
  $("chatInput").disabled=!canChat;$("chatInput").placeholder=canChat?"Tulis pesan...":"Chat belum tersedia";
  currentAction=null;
  const panel=$("actionPanel"),target=$("target");
  target.innerHTML='<option value="">Pilih pemain...</option>';
  const me=state.me;
  let type=null,title="",desc="";
  if(state.phase==="night"&&me?.alive){
    if(me.role==="Guardian"){type="guardian";title="Lindungi pemain";desc=roleHelp.Guardian}
    if(me.role==="Seer"){type="seer";title="Periksa pemain";desc=roleHelp.Seer}
    if(me.role==="Werewolf"){type="wolf";title="Serang pemain";desc=roleHelp.Werewolf}
    if(me.role==="White Jack"){type="whitejack";title="Tebak Werewolf";desc=roleHelp["White Jack"]}
  } else if(state.phase==="day"&&me?.alive){type="vote";title="Voting";desc="Pilih pemain yang kamu curigai. Kamu tidak bisa memilih diri sendiri."}
  else if(state.phase==="hunter"&&state.me?.id===state.pendingHunter){type="hunterShot";title="Tembakan Hunter";desc="Pilih pemain yang ingin kamu tembak."}
  // Host state sengaja tidak membagikan pendingHunter; event khusus memberi tahu Hunter yang tereliminasi.
  if(state.phase==="hunter"&&state.me?.role==="Hunter"&&!state.me.alive){type="hunterShot";title="Tembakan Hunter";desc="Kamu tereliminasi oleh voting. Pilih satu pemain untuk ditembak."}
  if(type){
    currentAction=type;panel.classList.remove("hidden");$("actionTitle").textContent=title;$("actionDesc").textContent=desc;
    state.players.filter(p=>p.alive&&p.id!==me.id).forEach(p=>{const o=document.createElement("option");o.value=p.id;o.textContent=p.name;target.appendChild(o)});
    $("doAction").textContent=type==="vote"?"Kirim vote":type==="hunterShot"?"Tembak pemain":"Konfirmasi aksi";
    $("doAction").disabled=false;
  }else panel.classList.add("hidden");
  if(state.phase==="ended"){panel.classList.add("hidden");addMessage("Permainan selesai. Pemenang: "+state.winner,true)}
}
$("doAction").onclick=()=>{
 const target=$("target").value;if(!target)return toast("Pilih pemain dulu.");
 if(currentAction==="vote")sendAck("vote",{target});
 else if(currentAction==="hunterShot")sendAck("hunterShot",{target});
 else sendAck("nightAction",{type:currentAction,target},()=>{$("doAction").disabled=true});
};