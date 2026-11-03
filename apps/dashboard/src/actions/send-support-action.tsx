"use server";
import {LogEvents}from"@midday/events/events";
import{z}from"zod";
import{getTRPCClient}from"@/trpc/server";
import{authActionClient}from"./safe-action";
export const sendSupportAction=authActionClient.schema(z.object({
 requestId:z.string().uuid(),subject:z.string().trim().min(1).max(200),
 priority:z.enum(["low","normal","high","urgent"]),
 type:z.enum(["Transactions","Vault","Inbox","Invoicing","Tracker","AI","General"]),
 message:z.string().trim().min(1).max(10000),
})).metadata({name:"send-support",track:{event:LogEvents.SupportTicket.name,channel:LogEvents.SupportTicket.channel}})
.action(async({parsedInput})=>{
 try{return await (await getTRPCClient()).support.submit.mutate(parsedInput);}
 catch{throw new Error("Receipt could not be confirmed. Your text is preserved; retry with the same reference.");}
});
