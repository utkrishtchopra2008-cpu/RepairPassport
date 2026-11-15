export const catalogVersion = '2026-11-15.1';
export const sources = [
  {id:'model',title:'Samsung India — WW80T504DAN1TL support',url:'https://www.samsung.com/in/support/model/WW80T504DAN1TL/',scope:'model_identity'},
  {id:'drain',title:'Samsung — washing machine will not drain',url:'https://www.samsung.com/us/support/troubleshoot/TSG10007110/',scope:'manufacturer_general_guidance'},
  {id:'spin',title:'Samsung — washing machine does not spin',url:'https://www.samsung.com/us/support/troubleshoot/TSG10003486/',scope:'manufacturer_general_guidance'},
  {id:'vibration',title:'Samsung — washing machine shaking',url:'https://www.samsung.com/us/support/troubleshoot/TSG10007111/',scope:'manufacturer_general_guidance'},
] as const;
export const product = {
  id:'samsung-ww80t504dan1tl',brand:'Samsung',model:'WW80T504DAN',variant:'1TL',full_model:'WW80T504DAN1TL',
  category:'washing_machine',support_url:sources[0].url,coverage:'curated_component_overview',
} as const;
export type Product = typeof product;
const normalize=(s:string)=>s.trim().toUpperCase().replace(/[\s\-/_]/g,'');
export function resolveProduct(brand:string, model:string, variant?:string|null) {
  const b=normalize(brand),m=normalize(model),v=variant==null?'':normalize(variant);
  if (b!==normalize(product.brand)) return {status:'unsupported',message:'Detailed component coverage is not available for this product.'};
  if ((m===product.full_model && (!v || v===product.variant)) || (m===product.model && v===product.variant)) return {status:'supported',product};
  if (m===product.model && !v) return {status:'variant_required',supported_variants:[product.variant],message:'Confirm the complete model/variant from the product label; the base model alone is not an exact match.'};
  return {status:'unsupported',message:'Detailed component coverage is not available for this exact model/variant.'};
}
export function matchOwnedProduct(appliance:{brand:string;model:string}):Product|null {
  return resolveProduct(appliance.brand,appliance.model).status==='supported' ? product:null;
}
export const components = [
  {id:'drum',name:'Drum',function:'Holds laundry and rotates during washing and spinning.',common_symptoms:['No rotation','Uneven load'],inspection:'external_observation',source_ids:['spin','vibration']},
  {id:'drain_hose',name:'Drain hose',function:'Carries wastewater out of the washer.',common_symptoms:['Water remains','Poor drainage'],inspection:'external_observation',source_ids:['drain']},
  {id:'pump_filter',name:'Pump debris filter',function:'Collects debris in the drainage path.',common_symptoms:['Restricted drainage'],inspection:'technician_only',source_ids:['drain']},
  {id:'drain_pump',name:'Drainage pump subsystem',function:'Moves water through the drainage path.',common_symptoms:['Persistent drainage failure'],inspection:'technician_only',source_ids:['drain','spin']},
  {id:'motor',name:'Motor/drive subsystem',function:'Powers drum rotation; exact subparts require model-specific service information.',common_symptoms:['Drum never rotates'],inspection:'technician_only',source_ids:['spin']},
  {id:'door',name:'Door assembly',function:'Closes the wash compartment; interlock details require service documentation.',common_symptoms:['Door not closed'],inspection:'external_observation',source_ids:['model']},
  {id:'control_panel',name:'Controls and display',function:'Selects cycles and displays settings or error codes.',common_symptoms:['Unexpected cycle settings','Displayed error'],inspection:'external_observation',source_ids:['model']},
  {id:'leveling_feet',name:'Leveling feet',function:'Support stable contact with the floor.',common_symptoms:['Rocking','Excessive vibration'],inspection:'external_observation',source_ids:['vibration']},
  {id:'shipping_bolts',name:'Shipping bolts',function:'Restrain movement during transport; installation status matters.',common_symptoms:['Vibration after installation'],inspection:'technician_only',source_ids:['vibration']},
  {id:'detergent_drawer',name:'Detergent drawer',function:'Holds detergent for dispensing during a cycle.',common_symptoms:[],inspection:'external_observation',source_ids:['model']},
] as const;
export const connections = [
  {from:'drum',to:'drain_pump',relationship:'Water leaves the wash compartment through the drainage subsystem.'},
  {from:'pump_filter',to:'drain_pump',relationship:'Debris restriction can affect drainage.'},
  {from:'drain_pump',to:'drain_hose',relationship:'Wastewater exits through the hose.'},
  {from:'motor',to:'drum',relationship:'The drive subsystem powers rotation.'},
  {from:'leveling_feet',to:'drum',relationship:'Installation stability affects vibration.'},
  {from:'shipping_bolts',to:'drum',relationship:'Transport restraints affect installation readiness.'},
] as const;
export function componentOverview(id:string) {
  if(id!==product.id)return {status:'unsupported',message:'Detailed component coverage is not available for this product ID.'};
  return {status:'supported',product,diagram:{kind:'illustrative_component_map',exact_geometry:false,
    notice:'Conceptual subsystem overview, not an exact exploded drawing or complete parts list. Confirm replacement compatibility with a technician.'},components,connections,sources};
}
