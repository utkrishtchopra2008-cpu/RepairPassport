import { reviewAssessment } from '../_shared/ai-review.ts';
import { authenticate, cors, exactKeys, failure, invalid, jsonBody, method, object, ownedAppliance, response, uuid, type Dependencies } from '../_shared/http.ts';
import { catalogVersion, componentOverview, product, resolveProduct } from '../_shared/catalog.ts';
import { assess, text, validateAnswers, scenarioIds } from '../_shared/assessment.ts';
import { createShopSearch, validateShopQuery } from '../_shared/shops.ts';

export function createHandler(deps:Dependencies){
  const shops=createShopSearch();
  return async(req:Request):Promise<Response>=>{
    let headers:Headers|undefined;
    try{
      headers=cors(req,deps.env);
      if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
      method(req);
      const body=await jsonBody(req);exactKeys(body,['action','payload']);object(body.payload);
      const p=body.payload;
      if(body.action==='list_products'){
        exactKeys(p,[]);return response({products:[product],catalog_version:catalogVersion},headers);
      }
      if(body.action==='resolve_product'){
        exactKeys(p,['brand','model'],['variant']);
        const brand=text(p.brand,'brand',100)!,model=text(p.model,'model',120)!;
        const variant=p.variant===undefined||p.variant===null?null:text(p.variant,'variant',40);
        return response(resolveProduct(brand,model,variant),headers);
      }
      if(body.action==='components'){
        exactKeys(p,['product_id']);return response(componentOverview(text(p.product_id,'product_id',100)!),headers);
      }
      if(body.action!=='assess'&&body.action!=='ai_review'&&body.action!=='find_shops')throw invalid('Unknown action');
      if(body.action==='assess'||body.action==='ai_review'){
        exactKeys(p,body.action==='ai_review'?['appliance_id','symptoms','ai_consent']:['appliance_id','symptoms'],['scenario','answers','error_code']);
        if(body.action==='ai_review'&&p.ai_consent!==true)throw invalid('Explicit AI review consent is required');
        uuid(p.appliance_id);text(p.symptoms,'symptoms',2000);validateAnswers(p.answers);
        if(p.error_code!==undefined)text(p.error_code,'error_code',120,true);
        if(p.scenario!==undefined&&(typeof p.scenario!=='string'||!(scenarioIds as readonly string[]).includes(p.scenario)))throw invalid('Unsupported scenario');
      }else{
        exactKeys(p,['appliance_id','latitude','longitude','location_consent'],['radius_km','require_listed_brand','require_listed_category']);uuid(p.appliance_id);validateShopQuery(p);
      }
      const authorization=await authenticate(req,deps);
      const appliance=await ownedAppliance(p.appliance_id as string,authorization,deps);
      if(body.action==='assess'||body.action==='ai_review'){
        const assessment=assess(appliance,p);
        if(body.action==='assess')return response(assessment,headers);
        return response({assessment,ai_review:await reviewAssessment(assessment,appliance.id,authorization,deps)},headers);
      }
      return response(await shops(validateShopQuery(p),appliance,authorization,deps),headers);
    }catch(error){return failure(error,headers);}
  };
}
if(import.meta.main)Deno.serve(createHandler({env:name=>Deno.env.get(name),fetch}));
