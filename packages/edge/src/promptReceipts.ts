import type {ServerResponse} from "node:http";
import {normalizePromptReceipt,type PromptReceiptIdentity} from "@agent-console/shared/prompt-receipt";
import type {DaemonResult} from "./upstream.ts";
import {sendJson} from "./http.ts";

/** Project only public receipt metadata; daemon messages/details stay private. */
export function forwardPromptReceipt(res:ServerResponse,result:DaemonResult,identity:PromptReceiptIdentity,lookup=false):void {
  const body=result.body as {ok?:unknown;data?:{receipt?:unknown;submitted?:unknown;session_incarnation?:unknown;queued?:unknown};error?:{code?:unknown;details?:{receipt?:unknown}}}|undefined;
  const success=result.status>=200&&result.status<300&&body?.ok===true;
  // The edge validated the keyed body, so a daemon that rejects it as unknown
  // fields predates keyed prompts; it rejects before dispatch, so nothing was sent.
  if(!lookup&&result.status===400&&body?.error?.code==="invalid-json-body"){
    sendJson(res,400,{ok:false,error:{code:"keyed-prompt-unsupported",message:"This host's agent-session runtime does not support queued replies. The reply was not sent."}});return;
  }
  if(!lookup&&result.status===409&&body?.error?.code==="request-id-conflict"){
    sendJson(res,409,{ok:false,error:{code:"request-id-conflict",message:"This request identifier belongs to another prompt. The queued reply has been kept."}});return;
  }
  const receipt=normalizePromptReceipt(lookup?body?.data?.receipt:body?.data?.receipt??body?.error?.details?.receipt,identity);
  if(lookup){
    if(success&&receipt){sendJson(res,200,{ok:true,data:{receipt}});return;}
    if(result.status===404&&body?.error?.code==="prompt-receipt-not-found"){
      sendJson(res,404,{ok:false,error:{code:"prompt-receipt-not-found",message:"No delivery receipt is available for this request."}});return;
    }
  }else if(receipt){
    if(success&&receipt.outcome==="submitted"&&body?.data?.submitted===true&&body.data.session_incarnation===identity.session_incarnation){
      sendJson(res,result.status,{ok:true,data:{submitted:true,session_incarnation:identity.session_incarnation,receipt,...(body.data.queued===true?{queued:true}:{})}});return;
    }
    if(!success&&result.status>=400&&receipt.outcome==="refused"){
      sendJson(res,result.status,{ok:false,error:{code:receipt.code,message:"The queued prompt was refused before delivery.",details:{receipt}}});return;
    }
    if(receipt.outcome==="unknown"){
      sendJson(res,500,{ok:false,error:{code:receipt.code,message:"Queued prompt delivery is unknown.",details:{receipt}}});return;
    }
  }
  sendJson(res,result.status>=400?result.status:502,{ok:false,error:{message:lookup?"Could not confirm the queued prompt receipt.":"Invalid or unavailable keyed prompt acknowledgement."}});
}
