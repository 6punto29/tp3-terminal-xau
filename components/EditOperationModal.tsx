"use client";
// components/EditOperationModal.tsx
// Modal de edición de operaciones — compartido entre Terminal y Cuenta.
// Extraído de LiveTerminal.tsx para reutilización.

import { useState } from "react";

const MONO = "'JetBrains Mono','Fira Code',monospace";
const SANS = "'Inter',-apple-system,sans-serif";

const T = {
  bg:"var(--tp3-bg)",s1:"var(--tp3-s1)",s2:"var(--tp3-s2)",s3:"var(--tp3-s3)",
  border:"var(--tp3-border)",border2:"var(--tp3-border2)",
  text:"var(--tp3-text)",muted:"var(--tp3-muted)",dim:"var(--tp3-dim)",
  up:"var(--tp3-up)",down:"var(--tp3-down)",wait:"var(--tp3-wait)",
  accent:"var(--tp3-accent)",gold:"var(--tp3-gold)",
};

export type Direction = "LONG"|"SHORT";
export type OpsResult = "TP"|"SL"|"MANUAL"|null;

export interface EditableOperation {
  id: string;
  direccion: Direction;
  precio_entrada: number;
  sl: number;
  tp: number;
  lotaje: number | null;
  resultado: OpsResult;
  hora_apertura_mt5?: string | null;
}

export interface EditModalUpdate {
  id: string;
  direccion: Direction;
  precio_entrada: number;
  sl: number;
  tp: number;
  lotaje: number | null;
  resultado: OpsResult;
  pnl: number | null;
  hora_apertura_mt5: string | null;
}

interface EditOperationModalProps {
  op: EditableOperation;
  onClose: () => void;
  onSave: (updated: EditModalUpdate) => void;
}

export default function EditOperationModal({op, onClose, onSave}: EditOperationModalProps){
  const[dir,setDir]=useState<Direction>(op.direccion);
  const[entry,setEntry]=useState(op.precio_entrada.toFixed(2));
  const[sl,setSL]=useState(op.sl.toFixed(2));
  const[tp,setTP]=useState(op.tp.toFixed(2));
  const[lotaje,setLotaje]=useState(op.lotaje!=null?op.lotaje.toFixed(2):"");
  const[resultado,setResultado]=useState<OpsResult>(op.resultado);
  const[cierre,setCierre]=useState("");
  const[horaApertura,setHoraApertura]=useState(op.hora_apertura_mt5?op.hora_apertura_mt5.slice(0,16):"");
  const[saving,setSaving]=useState(false);

  const inp:React.CSSProperties={width:"100%",background:T.s2,border:`1px solid ${T.border2}`,
    borderRadius:5,padding:"5px 8px",color:T.text,fontFamily:SANS,fontSize:12,outline:"none",boxSizing:"border-box"};
  const lbl:React.CSSProperties={display:"block",fontSize:8,fontWeight:600,letterSpacing:"0.06em",
    textTransform:"uppercase",color:T.muted,marginBottom:3};

  const eNum=parseFloat(entry)||0;
  const slNum=parseFloat(sl)||0;
  const tpNum=parseFloat(tp)||0;
  const lotNum=parseFloat(lotaje)||0;
  const cNum=parseFloat(cierre)||0;

  // Preview del P&L en dólares
  const calcPnlDollar=():number|null=>{
    if(!eNum||!lotNum)return null;
    if(resultado==="TP"){
      const pts=dir==="LONG"?tpNum-eNum:eNum-tpNum;
      return pts*lotNum*100;
    }else if(resultado==="SL"){
      const pts=dir==="LONG"?eNum-slNum:slNum-eNum;
      return -pts*lotNum*100;
    }else if(resultado==="MANUAL"&&cNum>0){
      const pts=dir==="LONG"?cNum-eNum:eNum-cNum;
      return pts*lotNum*100;
    }
    return null;
  };
  const pnlPreview=calcPnlDollar();

  // R múltiplo preview
  const slPts=Math.abs(eNum-slNum);
  const dollarRisk=slPts*lotNum*100;
  const rPreview=dollarRisk>0&&pnlPreview!=null?pnlPreview/dollarRisk:null;

  const handleSave=async()=>{
    if(!eNum||!slNum||!tpNum)return;
    const pnl=calcPnlDollar();
    const horaAperturaMT5=horaApertura?new Date(horaApertura).toISOString():null;
    setSaving(true);
    try{onSave({id:op.id,direccion:dir,precio_entrada:eNum,sl:slNum,tp:tpNum,
      lotaje:lotNum>0?lotNum:null,resultado,pnl,hora_apertura_mt5:horaAperturaMT5});}
    finally{setSaving(false);}
  };

  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.78)",zIndex:1000,
      display:"flex",alignItems:"center",justifyContent:"center"}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:T.s1,border:`1px solid ${T.border}`,borderRadius:10,
        padding:"18px 20px",width:300,boxShadow:"0 20px 60px rgba(0,0,0,0.6)"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
          <span style={{fontFamily:SANS,fontSize:12,fontWeight:700,color:T.text}}>Editar operación</span>
          <button onClick={onClose} style={{background:"none",border:"none",color:T.muted,
            cursor:"pointer",fontSize:16,padding:0,lineHeight:1}}>✕</button>
        </div>

        <div style={{marginBottom:8}}>
          <label style={lbl}>Dirección</label>
          <select value={dir} onChange={e=>setDir(e.target.value as Direction)}
            style={{...inp,cursor:"pointer"}}>
            <option value="LONG">▲ LONG</option>
            <option value="SHORT">▼ SHORT</option>
          </select>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
          <div><label style={lbl}>Precio entrada</label>
            <input type="number" value={entry} onChange={e=>setEntry(e.target.value)} style={inp}/></div>
          <div><label style={{...lbl,color:T.gold}}>Lotaje</label>
            <input type="number" value={lotaje} placeholder="0.04"
              onChange={e=>setLotaje(e.target.value)} style={inp}/></div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
          <div><label style={{...lbl,color:T.down}}>SL</label>
            <input type="number" value={sl} onChange={e=>setSL(e.target.value)} style={inp}/></div>
          <div><label style={{...lbl,color:T.up}}>TP</label>
            <input type="number" value={tp} onChange={e=>setTP(e.target.value)} style={inp}/></div>
        </div>
        <div style={{marginBottom:8}}>
          <label style={{...lbl,color:T.accent}}>Hora apertura MT5 (opcional)</label>
          <input type="datetime-local" value={horaApertura} 
            onChange={e=>setHoraApertura(e.target.value)} style={inp}/>
          <div style={{fontSize:7,color:T.dim,fontFamily:SANS,marginTop:2}}>
            Para precisión del timer Hold. Si vacío, usa hora de registro.
          </div>
        </div>
        <div style={{marginBottom:8}}>
          <label style={lbl}>Resultado</label>
          <select value={resultado??""} onChange={e=>setResultado((e.target.value||null) as OpsResult)}
            style={{...inp,cursor:"pointer"}}>
            <option value="">Abierta</option>
            <option value="TP">TP ✅</option>
            <option value="SL">SL ❌</option>
            <option value="MANUAL">MANUAL</option>
          </select>
        </div>
        {resultado==="MANUAL"&&(
          <div style={{marginBottom:8}}>
            <label style={lbl}>Precio cierre real</label>
            <input type="number" value={cierre} placeholder="ej. 4701.72"
              onChange={e=>setCierre(e.target.value)} style={inp}/>
          </div>
        )}

        {/* Preview P&L */}
        {pnlPreview!=null&&(
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,marginBottom:10,
            padding:"6px 8px",borderRadius:5,background:T.s2,border:`1px solid ${T.border}`}}>
            <div>
              <div style={{fontSize:7,color:T.muted,letterSpacing:"0.05em",textTransform:"uppercase",marginBottom:2}}>P&L real</div>
              <div style={{fontFamily:MONO,fontSize:13,fontWeight:700,color:pnlPreview>=0?T.up:T.down}}>
                {pnlPreview>=0?"+":""}{pnlPreview>=0?"$"+pnlPreview.toFixed(0):"-$"+Math.abs(pnlPreview).toFixed(0)}
              </div>
            </div>
            <div>
              <div style={{fontSize:7,color:T.muted,letterSpacing:"0.05em",textTransform:"uppercase",marginBottom:2}}>R múltiplo</div>
              <div style={{fontFamily:MONO,fontSize:13,fontWeight:700,color:rPreview!=null&&rPreview>=0?T.up:T.down}}>
                {rPreview!=null?`${rPreview>=0?"+":""}${rPreview.toFixed(1)}R`:"--"}
              </div>
            </div>
          </div>
        )}

        <div style={{display:"flex",gap:6,marginTop:6}}>
          <button onClick={onClose} style={{flex:1,padding:"7px",background:T.s3,
            border:`1px solid ${T.border}`,borderRadius:6,color:T.muted,
            fontFamily:SANS,fontSize:11,cursor:"pointer"}}>Cancelar</button>
          <button onClick={handleSave} disabled={saving} style={{flex:2,padding:"7px",
            background:"linear-gradient(135deg,#C9A227,#E8B84B)",border:"none",borderRadius:6,
            color:"#1D1D1F",fontFamily:SANS,fontSize:11,fontWeight:700,
            cursor:saving?"not-allowed":"pointer",opacity:saving?0.6:1}}>
            {saving?"Guardando...":"Guardar cambios"}
          </button>
        </div>
      </div>
    </div>
  );
}
