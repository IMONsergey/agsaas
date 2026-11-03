import {db} from "@midday/db/client";
import {isSessionActive} from "./auth-session";
import { createSupabaseFetch } from "@midday/supabase/server-fetch";
import {
  createRemoteJWKSet,
  customFetch,
  type JWTPayload,
  jwtVerify,
} from "jose";

export type Session = {
  sessionId?: string;
  /** Trusted assurance claim from the verified Auth JWT, never user metadata. */
  aal?: "aal1" | "aal2";
  user: {
    id: string;
    email?: string;
    full_name?: string;
  };
  teamId?: string;
};

type SupabaseJWTPayload = JWTPayload & {
  email?: string;
  user_metadata?: {
    full_name?: string;
    [key: string]: string | undefined;
  };
};

// Primary: verify via JWKS (asymmetric ES256/RS256). jose caches the
// keyset in memory so only the first call hits the network.
const JWKS = createRemoteJWKSet(
  new URL(`${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
  { [customFetch]: createSupabaseFetch(process.env.SUPABASE_URL!) },
);

// Fallback: HS256 shared secret for tokens issued before key rotation.
// Remove this once the legacy JWT secret is revoked in Supabase.
const HS256_SECRET = process.env.SUPABASE_JWT_SECRET
  ? new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET)
  : null;

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const acceptedIssuers=Array.from(new Set([
 process.env.SUPABASE_AUTH_ISSUER,
 ...[process.env.SUPABASE_URL,process.env.SUPABASE_PUBLIC_URL,process.env.NEXT_PUBLIC_SUPABASE_URL]
   .filter((value):value is string=>!!value).map(value=>`${value.replace(/\/$/,"")}/auth/v1`),
].filter((value):value is string=>!!value)));

function extractSession(payload:JWTPayload):Session|null {
 const p=payload as SupabaseJWTPayload;
 if(typeof p.sub!=="string" || !uuid.test(p.sub) || p.role!=="authenticated" ||
   typeof p.session_id!=="string" || !uuid.test(p.session_id))return null;
 return {sessionId:p.session_id,aal:p.aal==="aal2"?"aal2":"aal1",user:{
   id:p.sub,email:typeof p.email==="string"?p.email:undefined,
   full_name:p.user_metadata?.full_name,
 }};
}
export async function verifyAccessToken(accessToken?:string):Promise<Session|null>{
 if(!accessToken || accessToken.length>16384)return null;
 let payload:JWTPayload|null=null;
 const options={audience:"authenticated",issuer:acceptedIssuers,requiredClaims:["sub","iat","exp","session_id"],algorithms:["ES256","RS256"]};
 try{payload=(await jwtVerify(accessToken,JWKS,options)).payload;}catch{}
 if(!payload && HS256_SECRET){
   try{payload=(await jwtVerify(accessToken,HS256_SECRET,{...options,algorithms:["HS256"]})).payload;}catch{}
 }
 if(!payload)return null;
 const session=extractSession(payload);
 if(!session?.sessionId)return null;
 // No cross-request allow cache: logout and deletion must take effect on primary.
 return await isSessionActive(db,session.user.id,session.sessionId)?session:null;
}
