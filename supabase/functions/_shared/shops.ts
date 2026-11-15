import { boundedText, invalid, object, rpc, type Dependencies, type ObjectValue } from './http.ts';

type Position={latitude:number;longitude:number;radius_km:number};
export type ShopQuery=Position&{location_consent:true;require_listed_brand:boolean;require_listed_category:boolean};
export function validateShopQuery(p:ObjectValue):ShopQuery {
  for(const [key,limit] of [['latitude',90],['longitude',180]] as const){
    if(typeof p[key]!=='number'||!Number.isFinite(p[key])||Math.abs(p[key])>limit)throw invalid(`Valid ${key} required`);
  }
  if(p.location_consent!==true)throw invalid('Explicit consent to share the approximate search area is required');
  const radius=p.radius_km===undefined?5:p.radius_km;
  if(typeof radius!=='number'||!Number.isInteger(radius)||radius<1||radius>10)throw invalid('radius_km must be an integer from 1 to 10');
  for(const key of ['require_listed_brand','require_listed_category'])if(p[key]!==undefined&&typeof p[key]!=='boolean')throw invalid(`Expected boolean: ${key}`);
  return {latitude:p.latitude as number,longitude:p.longitude as number,radius_km:radius,location_consent:true,require_listed_brand:p.require_listed_brand===true,require_listed_category:p.require_listed_category===true};
}
export function searchArea(query:Position):Position {
  return {latitude:Number(query.latitude.toFixed(3)),longitude:Number(query.longitude.toFixed(3)),radius_km:query.radius_km};
}
export function overpassQuery(area:Position) {
  // 200 m padding covers rounding offset; results are filtered to the requested radius afterwards.
  const around=`(around:${area.radius_km*1000+200},${area.latitude},${area.longitude})`;
  return `[out:json][timeout:8][maxsize:1048576];(nwr${around}["shop"~"^(appliance|electrical)$"]["repair"~"^(yes|only)$"];nwr${around}["repair"="electrical_appliances"];nwr${around}["repair:washing_machines"="yes"];nwr${around}["service:repair:washing_machines"="yes"];);out center 100;`;
}
const clean=(v:unknown,max=200):string|null=>typeof v==='string'&&v.trim()?v.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):null;
export function distanceKm(a:Position,b:{latitude:number;longitude:number}) {
  const rad=(degrees:number)=>degrees*Math.PI/180;
  const dlat=rad(b.latitude-a.latitude),dlon=rad(b.longitude-a.longitude);
  const h=Math.sin(dlat/2)**2+Math.cos(rad(a.latitude))*Math.cos(rad(b.latitude))*Math.sin(dlon/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(Math.max(0,h)),Math.sqrt(Math.max(0,1-h)));
}
function matchingBrand(tags:Record<string,unknown>,brand:string) {
  const listed=[tags['repair:brand'],tags['service:repair:brand']].filter(v=>typeof v==='string').join(';');
  return listed.split(/[;,|]/).some(v=>v.trim().toLowerCase()===brand.trim().toLowerCase());
}
function washingMachineListed(tags:Record<string,unknown>) {
  return tags['repair:washing_machines']==='yes'||tags['service:repair:washing_machines']==='yes';
}
function applianceRepairListed(tags:Record<string,unknown>) {
  return washingMachineListed(tags)||tags.repair==='electrical_appliances'||(['appliance','electrical'].includes(String(tags.shop))&&['yes','only'].includes(String(tags.repair)));
}
export function normalizeShops(elements:unknown[],query:ShopQuery,brand:string) {
  const unique=new Map<string,{
    id:string;name:string;address:string|null;phone:string|null;latitude:number;longitude:number;distance_km:number;
    distance_type:string;category_support:string;brand_support:string;parts_availability:string;verification:string;rating:null;
    opening_hours:string|null;source_url:string;directions_url:string;
  }>();
  for(const value of elements){
    if(!value||typeof value!=='object'||Array.isArray(value))continue;
    const e=value as Record<string,unknown>;
    if(!['node','way','relation'].includes(String(e.type))||!Number.isSafeInteger(e.id)||Number(e.id)<=0)continue;
    if(!e.tags||typeof e.tags!=='object'||Array.isArray(e.tags))continue;
    const tags=e.tags as Record<string,unknown>;
    if(!applianceRepairListed(tags)||tags.disused==='yes'||tags.abandoned==='yes')continue;
    const name=clean(tags.name,160);if(!name)continue;
    const center=e.center&&typeof e.center==='object'?e.center as Record<string,unknown>:{};
    const lat=e.type==='node'?e.lat:center.lat,lon=e.type==='node'?e.lon:center.lon;
    if(typeof lat!=='number'||!Number.isFinite(lat)||Math.abs(lat)>90||typeof lon!=='number'||!Number.isFinite(lon)||Math.abs(lon)>180)continue;
    const distance=distanceKm(query,{latitude:lat,longitude:lon});if(distance>query.radius_km)continue;
    const category=washingMachineListed(tags),brandListed=matchingBrand(tags,brand);
    if(query.require_listed_category&&!category||query.require_listed_brand&&!brandListed)continue;
    const id=`${e.type}/${e.id}`;
    const address=clean(tags['addr:full'])||clean(['addr:housenumber','addr:street','addr:suburb','addr:city','addr:postcode'].map(key=>clean(tags[key],100)).filter(Boolean).join(', '));
    const contact=clean(tags['contact:phone']??tags.phone,40);
    const phone=contact&&/^[+\d ()-]{3,40}$/.test(contact)?contact:null;
    unique.set(id,{id,name,address,phone,latitude:lat,longitude:lon,distance_km:Math.round(distance*100)/100,
      distance_type:'straight_line_approximate',category_support:category?'washing_machine_listed':'appliance_repair_listed',
      brand_support:brandListed?'listed':'unknown',parts_availability:'unknown',verification:'community_listing_unverified',rating:null,
      opening_hours:clean(tags.opening_hours,200),source_url:`https://www.openstreetmap.org/${id}`,
      directions_url:`https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`});
  }
  // Sort by unrounded distance; otherwise near-equal rounded distances could reorder incorrectly.
  return [...unique.values()].sort((a,b)=>distanceKm(query,a)-distanceKm(query,b)||a.id.localeCompare(b.id)).slice(0,20);
}
const notice='Community listings may be incomplete or outdated. Distances are approximate straight-line distances among returned listings. Contact to confirm service and parts availability.';
const base=(query:ShopQuery)=>({search_area:searchArea(query),attribution:'© OpenStreetMap contributors (ODbL)',attribution_url:'https://www.openstreetmap.org/copyright',truncated:false,notice});
// Public listings only, coarse area only. Bounded, short-lived warm-instance cache; no account data.
export function createShopSearch(){
  const cache=new Map<string,{expires:number;elements:unknown[]}>();
  return async(query:ShopQuery,appliance:{id:string;brand:string},authorization:string,deps:Dependencies)=>{
    const area=searchArea(query),key=JSON.stringify(area),cached=cache.get(key);
    let elements:unknown[];
    if(cached&&cached.expires>Date.now())elements=cached.elements;
    else {
      await rpc('claim_support_lookup',{p_appliance_id:appliance.id},authorization,deps);
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
      try{
        const result=await deps.fetch('https://overpass-api.de/api/interpreter',{
          method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':'RepairPassport-Hackathon/1.0 (https://repairpassport-utkrisht.web.app)'},
          body:new URLSearchParams({data:overpassQuery(area)}).toString(),redirect:'error',signal:controller.signal,
        });
        if(!result.ok){await result.body?.cancel();return {...base(query),status:'unavailable',reason:'upstream_error',shops:[]};}
        const body:unknown=JSON.parse(await boundedText(result,1048576));object(body);
        if(body.remark||!Array.isArray(body.elements)||body.elements.length>1000)return {...base(query),status:'unavailable',reason:'invalid_response',shops:[]};
        elements=body.elements;
        if(cache.size>=32)cache.delete(cache.keys().next().value!);
        cache.set(key,{expires:Date.now()+300000,elements});
      }catch(error){
        return {...base(query),status:'unavailable',reason:controller.signal.aborted?'timeout':error instanceof TypeError?'upstream_error':'invalid_response',shops:[]};
      }finally{clearTimeout(timer);}
    }
    const shops=normalizeShops(elements,query,appliance.brand);
    return {...base(query),status:shops.length?'found':'empty',shops,truncated:elements.length>=100||normalizeShops(elements,{...query,require_listed_brand:false,require_listed_category:false},appliance.brand).length>=20};
  };
}
