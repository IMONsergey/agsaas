import type{Database}from"@midday/db/client";
import{isAuthSessionActive}from"@midday/db/queries";
export async function isSessionActive(db:Database,userId:string,sessionId:string){
 return isAuthSessionActive(db,userId,sessionId);
}
