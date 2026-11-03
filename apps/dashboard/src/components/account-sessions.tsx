"use client";
import {Button} from "@midday/ui/button";
import{Card,CardContent,CardDescription,CardHeader,CardTitle}from"@midday/ui/card";
import{createClient}from"@midday/supabase/client";
import{useMutation,useQuery,useQueryClient}from"@tanstack/react-query";
import{useState}from"react";
import{useTRPC}from"@/trpc/client";
export function AccountSessions(){
 const trpc=useTRPC();const cache=useQueryClient();const [notice,setNotice]=useState<string|null>(null);
 const sessions=useQuery(trpc.user.sessions.queryOptions());
 const revoke=useMutation(trpc.user.revokeSessions.mutationOptions({
   onSuccess:async(result,input)=>{
     if(input.scope==="all"){
       await createClient().auth.signOut({scope:"local"}).catch(()=>{});
       window.location.assign("/login");return;
     }
     setNotice(`Signed out ${result.revoked} other browser sessions.`);
     await cache.invalidateQueries({queryKey:trpc.user.sessions.queryKey()});
   },
   onError:error=>setNotice(error.message||"Session revocation could not be confirmed. Please retry."),
 }));
 return <Card><CardHeader><CardTitle>Browser sessions</CardTitle><CardDescription>Review recent sessions and sign out browsers you no longer use. API keys and connected applications have separate access controls in Developer settings.</CardDescription></CardHeader><CardContent className="space-y-4">
   {sessions.isPending&&<p role="status">Loading sessions…</p>}
   {sessions.isError&&<p role="alert">Sessions could not be checked. <button type="button" className="underline" onClick={()=>void sessions.refetch()}>Retry</button></p>}
   <ul className="space-y-3">{sessions.data?.map(session=><li key={session.id} className="border p-3 text-sm break-words">
     <p className="font-medium">{session.current?"This browser":"Other browser"} · {session.ip??"IP unavailable"}</p>
     <p>{session.userAgent??"Device details unavailable"}</p>
     <p className="text-muted-foreground">Signed in {session.createdAt?new Date(session.createdAt).toLocaleString():"at an unknown time"}{session.refreshedAt?` · Last refresh ${new Date(session.refreshedAt).toLocaleString()}`:""}</p>
   </li>)}</ul>
   {notice&&<p role="status" className="text-sm">{notice}</p>}
   <div className="flex flex-wrap gap-3">
     <Button variant="outline" disabled={revoke.isPending||!sessions.data?.some(s=>!s.current)} onClick={()=>revoke.mutate({scope:"others"})}>Sign out other browsers</Button>
     <Button variant="outline" disabled={revoke.isPending||!sessions.data?.length} onClick={()=>revoke.mutate({scope:"all"})}>Sign out all browsers</Button>
   </div>
 </CardContent></Card>;
}
