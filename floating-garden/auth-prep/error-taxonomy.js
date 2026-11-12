// Fixed strings from Firebase JS SDK firebase@10.8.0 app-check/src/errors.ts.
// These classify SDK errors, not server cause, request delivery, or account state.
const codes=new Set(['already-initialized','use-before-activation','fetch-network-error','fetch-parse-error','fetch-status-error','storage-open','storage-get','storage-set','recaptcha-error','throttled'].map(s=>'appCheck/'+s));
export function allowlistedCode(value){return typeof value==='string'&&codes.has(value)?value:'unknown';}
export function classifyAppCheckError(error){
  try {const descriptor=Object.getOwnPropertyDescriptor(error,'code');return allowlistedCode(descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined);}
  catch{return 'unknown';}
}
