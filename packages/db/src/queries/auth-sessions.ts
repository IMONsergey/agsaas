import {sql} from "drizzle-orm";
import type{Database,DatabaseOrTransaction}from"../client";
function primary(db:DatabaseOrTransaction){
 const source=db as Database&{$primary?:Database;usePrimaryOnly?:()=>Database};
 return source.usePrimaryOnly?.()??source.$primary??db;
}
export async function isAuthSessionActive(db:DatabaseOrTransaction,userId:string,sessionId:string){
 const result=await primary(db).execute(sql`SELECT private.auth_session_active(${userId}::uuid,${sessionId}::uuid) AS active`);
 return result.rows[0]?.active===true;
}
export async function getOwnAuthSessions(db:DatabaseOrTransaction,userId:string,currentSessionId:string){
 const result=await primary(db).execute(sql`SELECT id,created_at::text AS "createdAt",refreshed_at::text AS "refreshedAt",user_agent AS "userAgent",ip FROM private.own_auth_sessions(${userId}::uuid)`);
 return (result.rows as unknown as Array<{id:string;createdAt:string|null;refreshedAt:string|null;userAgent:string|null;ip:string|null}>).map(session=>({...session,current:session.id===currentSessionId}));
}
export async function revokeAuthSessions(db:DatabaseOrTransaction,userId:string,currentSessionId:string,scope:"all"|"others"){
 const result=await primary(db).execute(sql`SELECT private.revoke_auth_sessions(${userId}::uuid,${currentSessionId}::uuid,${scope}) AS count`);
 return {revoked:Number(result.rows[0]?.count??0)};
}
