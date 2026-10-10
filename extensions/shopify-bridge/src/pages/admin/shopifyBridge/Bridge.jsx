import React,{useEffect,useState} from 'react';
export default function Bridge() {
  const [status,setStatus]=useState(null),[platform,setPlatform]=useState('all'),[orders,setOrders]=useState([]),[shop,setShop]=useState(null),[error,setError]=useState(''),[selected,setSelected]=useState(null);
  useEffect(()=>{fetch('/api/shopify/status',{credentials:'same-origin'}).then(r=>r.json()).then(r=>setStatus(r.data||{error:r.error})).catch(()=>setStatus({error:true}));},[]);
  useEffect(()=>{setSelected(null);fetch(`/api/shopify/orders?platform=${platform}`,{credentials:'same-origin'}).then(r=>r.json()).then(r=>{if(r.error)throw new Error();setOrders(r.data.orders);setShop(r.data.shopDomain);setError('');}).catch(()=>setError('Order view requires the bridge migration.'));},[platform]);
  async function selectOrder(order){
    try{const response=await fetch(`/api/shopify/orders?platform=${order.platform}&orderId=${encodeURIComponent(order.order_id)}`,{credentials:'same-origin'});const result=await response.json();if(!response.ok)throw new Error();setSelected(result.data);}catch{setError('Order is unavailable; refresh the native platform.');}
  }
  return <div className="p-8"><h1>SHUSHA operations</h1><p>EverShop manages products and source prices. Shopify imports start as drafts.</p>
    <p>{status?.error?'Bridge configuration is required.':status?`${status.connected?'Credentials saved':'Authorization required'} · ${status.mappedStyles} mapped styles · ${status.writesEnabled?'Writes enabled':'Writes paused'}`:'Loading…'}</p>
    {status?.enabled&&<a href="/api/shopify/oauth/start">Review Shopify installation permissions</a>}
    <p>Store opening requires verified catalog, shared capacity and payment access.</p>
    <label>Platform <select value={platform} onChange={event=>setPlatform(event.target.value)}><option value="all">Both stores</option><option value="evershop">EverShop</option><option value="shopify">Shopify</option></select></label>
    {error&&<p role="alert">{error}</p>}
    <table className="w-full mt-4"><thead><tr><th>Platform</th><th>Order</th><th>Total</th><th>Payment</th><th>Shipment</th><th>Open</th></tr></thead><tbody>{orders.map(order=><tr key={`${order.platform}:${order.order_id}`}><td>{order.platform==='shopify'?'Shopify':'EverShop'}</td><td>{order.number}</td><td>{order.currency} {order.total}</td><td>{order.payment_status}</td><td>{order.fulfillment_status}</td><td>{order.platform==='evershop'?<a href={`/admin/order/edit/${order.native_uuid}`}>Native order</a>:<><button type="button" onClick={()=>selectOrder(order)}>Operations</button>{shop&&<a href={`https://admin.shopify.com/store/${shop.replace('.myshopify.com','')}/orders/${order.order_id.split('/').pop()}`} target="_blank" rel="noopener noreferrer">Native order</a>}</>}</td></tr>)}</tbody></table>
    {selected&&<div className="mt-6"><h2>Shopify {selected.native.number}</h2><p>Preferred courier: {selected.native.private_snapshot?.preferredCourier || 'No preference'}</p><ul>{selected.lines.map(line=><li key={line.id}>{line.sku} × {line.quantity}</li>)}</ul><p>Shipping and incoming funds require independent merchant confirmation.</p></div>}
  </div>;
}
export const layout={areaId:'content',sortOrder:10};
