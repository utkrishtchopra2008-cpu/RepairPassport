import {boundedText,exactKeys,invalid,object,rpc,type Dependencies} from './http.ts';
import {assess} from './assessment.ts';
import {sources} from './catalog.ts';

type Assessment=ReturnType<typeof assess>;
type Ranking={candidate_id:string;evidence_indexes:number[];uncertainty:'needs_inspection'|'insufficient_evidence'};
export type AIReview={
 status:'reviewed'|'unavailable'|'skipped';reason?:'not_configured'|'timeout'|'upstream_error'|'invalid_response'|'refused'|'incomplete_response'|'insufficient_assessment';
 engine:'openai_structured_review';is_ai_generated:boolean;model?:string;
 ranked_candidates:{candidate_id:string;evidence:string[];source_ids:string[];uncertainty:'needs_inspection'|'insufficient_evidence'}[];
 notice:string;
};
const notice='AI-assisted prioritization may be incorrect. All listed causes remain unconfirmed; qualified inspection is needed before part replacement.';
const base=():AIReview=>({status:'unavailable',engine:'openai_structured_review',is_ai_generated:false,ranked_candidates:[],notice});
export function validateRanking(value:unknown,assessment:Assessment):Ranking[]{
 object(value);exactKeys(value,['ranking']);
 if(!Array.isArray(value.ranking)||value.ranking.length!==assessment.candidates.length)throw invalid('Invalid candidate ranking');
 const seen=new Set<string>();const result:Ranking[]=[];
 for(const raw of value.ranking){
  object(raw);exactKeys(raw,['candidate_id','evidence_indexes','uncertainty']);
  if(typeof raw.candidate_id!=='string'||seen.has(raw.candidate_id))throw invalid('Invalid candidate reference');
  const candidate=assessment.candidates.find(c=>c.id===raw.candidate_id);
  if(!candidate)throw invalid('Invalid candidate reference');seen.add(raw.candidate_id);
  if(!Array.isArray(raw.evidence_indexes)||raw.evidence_indexes.length===0||raw.evidence_indexes.length>candidate.evidence.length)throw invalid('Invalid evidence reference');
  const indexes=raw.evidence_indexes;
  if(indexes.some(i=>!Number.isInteger(i)||i<0||i>=candidate.evidence.length)||new Set(indexes).size!==indexes.length)throw invalid('Invalid evidence reference');
  if(raw.uncertainty!=='needs_inspection'&&raw.uncertainty!=='insufficient_evidence')throw invalid('Invalid uncertainty');
  result.push({candidate_id:raw.candidate_id,evidence_indexes:indexes,uncertainty:raw.uncertainty});
 }
 return result;
}
export async function reviewAssessment(assessment:Assessment,applianceId:string,authorization:string,deps:Dependencies):Promise<AIReview>{
 if(assessment.status!=='possible_causes'||!assessment.product||!assessment.candidates.length)return {...base(),status:'skipped',reason:'insufficient_assessment'};
 const key=deps.env('OPENAI_API_KEY'),model=deps.env('OPENAI_MODEL');
 if(!key||!model||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(model))return {...base(),reason:'not_configured'};
 await rpc('claim_support_lookup',{p_appliance_id:applianceId},authorization,deps);
 // Projection is intentional: never serialize the assessment/report/raw observations wholesale.
 const input={
  product:{brand:assessment.product.brand,model:assessment.product.full_model},
  scenario:assessment.scenario,answers:assessment.report.user_observations.answers,
  candidates:assessment.candidates.map(c=>({id:c.id,component_ids:c.component_ids,summary:c.summary,evidence:c.evidence,missing_information:c.missing_information,source_ids:c.source_ids})),
  references:sources.map(s=>({id:s.id,title:s.title,scope:s.scope})),
 };
 const schema={type:'object',additionalProperties:false,required:['ranking'],properties:{ranking:{type:'array',items:{type:'object',additionalProperties:false,required:['candidate_id','evidence_indexes','uncertainty'],properties:{
  candidate_id:{type:'string',enum:assessment.candidates.map(c=>c.id)},evidence_indexes:{type:'array',items:{type:'integer'}},uncertainty:{type:'string',enum:['needs_inspection','insufficient_evidence']},
 }}}}};
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
 try{
  const upstream=await deps.fetch('https://api.openai.com/v1/responses',{
   method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},redirect:'error',signal:controller.signal,
   body:JSON.stringify({model,store:false,max_output_tokens:800,
    instructions:'Review only the supplied unconfirmed repair hypotheses. Rank all candidates exactly once using the supplied observations and evidence. Select valid zero-based evidence indexes for each candidate. Use insufficient_evidence whenever the supplied observations do not justify prioritization. This is not a diagnosis. Do not invent observations or treat generic manufacturer guidance as a model-specific fault confirmation. Return only the specified structured ranking; no new parts, instructions, prices, or replacement claims.',
    input:JSON.stringify(input),text:{format:{type:'json_schema',name:'repair_hypothesis_review',strict:true,schema}},
   }),
  });
  if(!upstream.ok){await upstream.body?.cancel();return {...base(),reason:'upstream_error'};}
  const parsed:unknown=JSON.parse(await boundedText(upstream,65536));object(parsed);
  if(parsed.status!=='completed')return {...base(),reason:'incomplete_response'};
  if(!Array.isArray(parsed.output))return {...base(),reason:'invalid_response'};
  const texts:string[]=[];
  for(const output of parsed.output){
   if(!output||typeof output!=='object'||output.type!=='message'||!Array.isArray(output.content))continue;
   for(const content of output.content){
    if(content?.type==='refusal')return {...base(),reason:'refused'};
    if(content?.type==='output_text'&&typeof content.text==='string')texts.push(content.text);
   }
  }
  if(texts.length!==1)return {...base(),reason:'invalid_response'};
  const ranking=validateRanking(JSON.parse(texts[0]),assessment);
  return {...base(),status:'reviewed',is_ai_generated:true,model,ranked_candidates:ranking.map(item=>{
   const candidate=assessment.candidates.find(c=>c.id===item.candidate_id)!;
   return {candidate_id:item.candidate_id,evidence:item.evidence_indexes.map(i=>candidate.evidence[i]),source_ids:[...candidate.source_ids],uncertainty:item.uncertainty};
  })};
 }catch(error){return {...base(),reason:controller.signal.aborted?'timeout':error instanceof TypeError?'upstream_error':'invalid_response'};}
 finally{clearTimeout(timer);}
}
