export function createExistingWindow({enabled,allowCreate,startsAtMs,endsAtMs}, now=Date.now) {
  const valid=enabled===true && allowCreate===false &&
    Number.isSafeInteger(startsAtMs) && Number.isSafeInteger(endsAtMs) &&
    startsAtMs>0 && endsAtMs>startsAtMs && endsAtMs-startsAtMs<=600000;
  let expired=false;
  return Object.freeze({
    isOpen(){
      if(!valid || expired)return false;
      const t=now();
      if(!Number.isFinite(t) || t>=endsAtMs){expired=true;return false;}
      return t>=startsAtMs;
    },
    valid,startsAtMs,endsAtMs,
  });
}
