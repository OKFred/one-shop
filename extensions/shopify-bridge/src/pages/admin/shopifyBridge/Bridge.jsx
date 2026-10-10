import React,{useEffect,useState} from 'react';
export default function Bridge() {
  const [status,setStatus] = useState(null);
  useEffect(()=>{fetch('/api/shopify/status',{credentials:'same-origin'}).then(r=>r.json()).then(r=>setStatus(r.data||{error:r.error})).catch(()=>setStatus({error:'Connection unavailable'}));},[]);
  return <div className="p-8"><h1>Shopify bridge</h1><p>EverShop manages products and source prices. Shopify imports start as drafts.</p>
    {status?.error?<p>Bridge configuration or migration is required.</p>:<p>{status?`${status.connected?'Credentials saved':'Authorization required'} · ${status.mappedStyles} mapped styles · ${status.writesEnabled?'Writes enabled':'Writes paused'}`:'Loading…'}</p>}
    {status?.enabled && <a href="/api/shopify/oauth/start">Review Shopify installation permissions</a>}
    <p>Store opening requires verified catalog, inventory opening balances and payment access rehearsal.</p>
  </div>;
}
export const layout = {areaId:'content',sortOrder:10};
