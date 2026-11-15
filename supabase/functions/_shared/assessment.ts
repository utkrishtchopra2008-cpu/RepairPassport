import { invalid, object, type ObjectValue } from './http.ts';
import { matchOwnedProduct, sources, type Product } from './catalog.ts';
export const scenarioIds=['no_drain','no_spin','vibration','unknown'] as const;
export type Scenario=typeof scenarioIds[number];
const binary=['yes','no','unknown'];
export const answerOptions:Record<string,string[]>={
  hazard_present:binary,water_remaining:binary,drain_hose_kinked:binary,load_unbalanced:binary,
  machine_level:binary,shipping_bolts_removed:binary,door_closed:binary,spin_disabled:binary,
  drum_moves_during_wash:binary,filter_condition:['clear','blocked','not_checked','unknown'],
};
const labels:Record<string,string>={
  hazard_present:'Have you noticed smoke, sparks, a burning smell, an electrical shock, or water near electrical connections?',
  water_remaining:'Is water still visible in the drum after the cycle?',
  drain_hose_kinked:'From a safe, accessible position, can you see an external kink in the drain hose?',
  load_unbalanced:'Was the load uneven, unusually bulky, or overloaded?',
  machine_level:'Has the installation been checked for a stable, level floor and support?',
  shipping_bolts_removed:'Has the installer confirmed that the shipping bolts were removed?',
  door_closed:'Does the door close normally without forcing it?',
  spin_disabled:'Was a no-spin or reduced-spin setting selected?',
  drum_moves_during_wash:'Did you observe drum movement during the normal wash phase?',
  filter_condition:'What is the last known condition of the pump filter? Do not open it to answer this question.',
};
const questionIds:Record<Exclude<Scenario,'unknown'>,string[]>={
  no_drain:['water_remaining','drain_hose_kinked','filter_condition'],
  no_spin:['water_remaining','spin_disabled','load_unbalanced','door_closed','drum_moves_during_wash'],
  vibration:['load_unbalanced','machine_level','shipping_bolts_removed'],
};
export type Answers=Record<string,string>;
export function validateAnswers(value:unknown):Answers {
  if(value===undefined)return {};
  object(value);
  for(const [key,answer] of Object.entries(value)) {
    if(!Object.hasOwn(answerOptions,key) || typeof answer!=='string' || !answerOptions[key].includes(answer))throw invalid('Unknown question or answer value');
  }
  return value as Answers;
}
export function text(value:unknown,name:string,max:number,nullable=false):string|null {
  if(nullable && value===null)return null;
  if(typeof value!=='string' || value.trim().length===0 || value.length>max)throw invalid(`${name} must be nonempty text under ${max+1} characters`);
  return value.trim();
}
function inferScenario(symptoms:string,errorCode:string|null,selected:Scenario):Scenario {
  if(selected!=='unknown')return selected;
  const code=(errorCode||'').trim().toUpperCase();
  const s=symptoms.toLowerCase().replace(/[’']/g,'');
  const drain=/\b(?:not draining|wont drain|does not drain|water remains|water remaining|water left|cannot drain|cant drain)\b/.test(s)||['5C','5E'].includes(code);
  const spin=/\b(?:not spinning|wont spin|does not spin|no spin|cannot spin|cant spin|drum does not rotate)\b/.test(s);
  const vibration=/\b(?:vibrat\w*|shaking|shake|banging)\b/.test(s);
  if(Number(drain)+Number(spin)+Number(vibration)!==1)return 'unknown';
  return drain?'no_drain':spin?'no_spin':'vibration';
}
export type Candidate={id:string;component_ids:string[];summary:string;evidence:string[];missing_information:string[];recommendation:'check_setup'|'professional_inspection';source_ids:string[]};
type Appliance={id:string;brand:string;model:string};
export function assess(appliance:Appliance,payload:ObjectValue) {
  const symptoms=text(payload.symptoms,'symptoms',2000)!;
  const errorCode=payload.error_code===undefined?null:text(payload.error_code,'error_code',120,true);
  const requested=payload.scenario===undefined?'unknown':payload.scenario;
  if(typeof requested!=='string' || !(scenarioIds as readonly string[]).includes(requested))throw invalid('Unsupported scenario');
  const answers=validateAnswers(payload.answers);
  const selectedProduct=matchOwnedProduct(appliance);
  const scenario=inferScenario(symptoms,errorCode,requested as Scenario);
  const notices=[
    'Possible causes, not a confirmed diagnosis. No part replacement is established by these observations.',
    'This assessment uses curated manufacturer-backed rules, not generative AI.',
    'Internal inspection and replacement compatibility require a qualified technician.',
  ];
  const result:{status:string;engine:string;is_ai_generated:boolean;product:Product|null;scenario:Scenario;questions:{id:string;label:string;options:string[]}[];candidates:Candidate[];safe_checks:string[];notices:string[];sources:typeof sources;repair_request:{appliance_id:string;symptoms:string;error_code:string|null};report:{user_observations:{symptoms:string;error_code:string|null;answers:Answers};assessment_label:string}}={
    status:'insufficient_information',engine:'curated_rules_v1',is_ai_generated:false,product:selectedProduct,scenario,questions:[],candidates:[],safe_checks:[],notices,sources,
    repair_request:{appliance_id:appliance.id,symptoms,error_code:errorCode},
    report:{user_observations:{symptoms,error_code:errorCode,answers},assessment_label:'Possible causes — not a confirmed diagnosis'},
  };
  // Keep explicit hazards even if a contradictory answer says no; handle simple negated observations.
  const hazardText=symptoms.replace(/\b(?:no|without|not)\s+(?:any\s+)?(?:smoke|sparks?|burning(?:\s+smell)?|fire|flames?|electrical?\s+shock)\b/gi,'');
  const hazard=answers.hazard_present==='yes'||/\b(?:smoke|sparks?|burning|fire|flames?|electrocution|electric(?:al)? shock|exposed wires?|water near (?:the )?(?:plug|socket|electrical))\b/i.test(hazardText);
  if(hazard){
    result.status='professional_inspection';
    result.notices.unshift('Stop using the appliance. Avoid touching it or entering water near electrical equipment; keep clear and seek qualified help. Do not run a test cycle.');
    return result;
  }
  if(!selectedProduct){result.status='unsupported_product';result.notices.unshift('The exact model/variant is not in the supported catalogue. Confirm the complete model code before using model-specific guidance.');return result;}
  const question=(id:string)=>({id,label:labels[id],options:[...answerOptions[id]]});
  if(scenario==='unknown'){
    result.questions=[question('hazard_present')];
    result.notices.unshift('Select the main symptom: drainage, spinning, or vibration. Ambiguous descriptions are not assigned a diagnosis.');
    return result;
  }
  const needed=[...questionIds[scenario],...(scenario==='no_spin'&&answers.water_remaining==='yes'?['drain_hose_kinked','filter_condition']:[])];
  const missing=needed.filter(id=>answers[id]===undefined||['unknown','not_checked'].includes(answers[id]));
  if(answers.hazard_present!=='no')result.questions.push(question('hazard_present'));
  result.questions.push(...missing.map(question));
  const add=(id:string,ids:string[],summary:string,evidence:string[],recommendation:Candidate['recommendation'],source:string)=>result.candidates.push({
    id,component_ids:ids,summary,evidence,missing_information:missing.map(id=>labels[id]),recommendation,source_ids:[source],
  });
  // The user has not yet ruled out immediate hazards: collect observations before any ordinary checks.
  if(answers.hazard_present!=='no'){result.status='needs_answers';return result;}
  result.safe_checks.push('Use the exact model manual. Limit observations to accessible external areas; do not remove panels, force the door, or reach inside the machine.');
  if(scenario==='no_drain'||(scenario==='no_spin'&&answers.water_remaining==='yes')){
    if(answers.drain_hose_kinked==='yes')add('external_drain_restriction',['drain_hose'],'An observed external hose kink could restrict drainage.',['Owner reports a visible hose kink.'],'check_setup','drain');
    if(answers.filter_condition==='blocked')add('reported_filter_blockage',['pump_filter'],'The reported filter blockage could restrict drainage.',['Owner reports a previously observed blockage.'],'professional_inspection','drain');
    if(answers.filter_condition!=='clear'&&answers.filter_condition!=='blocked')add('unconfirmed_filter_restriction',['pump_filter'],'A drainage restriction remains possible; the filter condition is unknown.',['Drainage-related symptom; no confirmed filter inspection.'],'professional_inspection','drain');
    if(answers.drain_hose_kinked!=='yes'&&answers.filter_condition!=='blocked')add('drainage_subsystem_inspection',['drain_pump','drain_hose'],'Persistent drainage failure may require inspection of the drainage subsystem. This does not establish a failed pump.',['Drainage symptom persists; internal cause is not confirmed.'],'professional_inspection','drain');
    if(scenario==='no_spin')result.notices.unshift('Water remaining can prevent the washer from advancing to spinning. Investigate drainage before assuming a motor fault.');
    result.safe_checks.push('Read the displayed error code and visually note accessible hose routing without moving a heavy appliance. Leave filter opening and internal inspection to a technician.');
  }
  if(scenario==='no_spin'){
    if(answers.spin_disabled==='yes')add('cycle_setting',['control_panel'],'A selected no-spin or reduced-spin setting may explain the observed cycle.',['Owner reports a relevant cycle setting.'],'check_setup','model');
    if(answers.load_unbalanced==='yes')add('unbalanced_spin_load',['drum'],'An uneven or bulky load may interrupt spinning.',['Owner reports an unbalanced load.'],'check_setup','vibration');
    if(answers.door_closed==='no')add('door_closure_observation',['door'],'An observed door-closure problem requires inspection; no interlock failure is established.',['Owner reports that the door does not close normally.'],'professional_inspection','model');
    if(answers.water_remaining==='no'&&answers.drum_moves_during_wash==='no')add('drive_subsystem_inspection',['motor','drum'],'A drum that never moves may need drive-subsystem inspection. The specific failed part is unknown.',['Owner reports no wash-phase drum movement and no remaining water.'],'professional_inspection','spin');
    result.safe_checks.push('Note the selected cycle, displayed spin setting and whether the door closes normally. Do not force a locked door or bypass a switch.');
  }
  if(scenario==='vibration'){
    if(answers.load_unbalanced==='yes')add('unbalanced_load',['drum'],'The reported uneven load may contribute to vibration.',['Owner reports an unbalanced load.'],'check_setup','vibration');
    if(answers.machine_level==='no')add('unstable_installation',['leveling_feet'],'An unstable installation may contribute to vibration.',['Owner reports that installation is not level/stable.'],'professional_inspection','vibration');
    if(answers.shipping_bolts_removed==='no')add('transport_restraints',['shipping_bolts'],'Reported shipping restraints need installer attention before further operation.',['Owner reports shipping bolts were not removed.'],'professional_inspection','vibration');
    if(result.candidates.length===0&&missing.length===0)add('persistent_vibration_inspection',['drum','leveling_feet'],'Persistent vibration after reported setup checks needs professional inspection; internal part failure is unconfirmed.',['Reported installation/load checks do not explain the symptom.'],'professional_inspection','vibration');
    result.safe_checks.push('Record load size and whether vibration started after installation or moving. Ask the installer to verify leveling and transport-restraint removal.');
  }
  result.status=result.questions.length>0?'needs_answers':result.candidates.length>0?'possible_causes':'insufficient_information';
  if(!result.candidates.length&&!result.questions.length)result.notices.unshift('These observations do not identify a component. Request professional inspection rather than replacing a guessed part.');
  return result;
}
