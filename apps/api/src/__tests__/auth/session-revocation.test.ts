import{describe,it,expect}from"bun:test";
import{verifyAccessToken,signAccessToken,sessionState,checkSession,actorId,sessionId}from"./jwt-fixture";
describe("current browser session checks",()=>{
 it("accepts each supported signature only with an active session",async()=>{
   for(const algorithm of ["ES256","RS256","HS256"]as const){
     const token=await signAccessToken({},algorithm);
     expect((await verifyAccessToken(token))?.sessionId).toBe(sessionId);
     sessionState.active=false;
     expect(await verifyAccessToken(token)).toBeNull();
     sessionState.active=true;
   }
   expect(checkSession.mock.calls.every(args=>args[1]===actorId&&args[2]===sessionId)).toBe(true);
 });
 it("rejects missing, malformed, foreign issuer, wrong role and missing expiry before session lookup",async()=>{
   for(const claims of [{session_id:null},{session_id:"invalid"},{iss:"https://foreign.example.test/auth/v1"},{role:"service_role"},{exp:undefined},{sub:"malformed"}]){
     checkSession.mockClear();
     expect(await verifyAccessToken(await signAccessToken(claims))).toBeNull();
     expect(checkSession).not.toHaveBeenCalled();
   }
 });
 it("fails closed when current session state cannot be read",async()=>{
   sessionState.unavailable=true;
   expect(verifyAccessToken(await signAccessToken())).rejects.toThrow("Auth session check unavailable");
 });
});
