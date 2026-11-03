"use server";
import{LogEvents}from"@midday/events/events";
import{z}from"zod";
import{getTRPCClient}from"@/trpc/server";
import{authActionClient}from"./safe-action";
export const sendFeebackAction=authActionClient.schema(z.object({
 requestId:z.string().uuid(),feedback:z.string().trim().min(1).max(10000),
})).metadata({name:"send-feedback",track:{event:LogEvents.SendFeedback.name,channel:LogEvents.SendFeedback.channel}})
.action(async({parsedInput:{requestId,feedback}})=>{
 try{return await (await getTRPCClient()).support.submit.mutate({requestId,subject:"Feedback",priority:"low",type:"General",message:feedback});}
 catch{throw new Error("Receipt could not be confirmed. Your text is preserved; retry with the same reference.");}
});
