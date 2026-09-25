import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import nodemailer from 'nodemailer';
export async function sendAccountMail({to,url,kind},env=process.env){
 const subject={verify:'Verify your Winnigo email',reset:'Reset your Winnigo password',delete:'Confirm your Winnigo account deletion'}[kind];
 if(!subject)throw Error('Invalid account message');
 if(env.WINNIGO_MAIL_MODE==='file'){
  if(!['127.0.0.1','localhost','::1'].includes(env.WINNIGO_HOST)||!['127.0.0.1','localhost','[::1]'].includes(new URL(env.WINNIGO_ORIGIN).hostname))throw Error('Local mail outbox requires loopback');
  const directory=resolve(env.WINNIGO_MAIL_DIR||'.winnigo/mail');await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(resolve(directory,randomUUID()+'.json'),JSON.stringify({to,url,kind,subject}),{mode:0o600,flag:'wx'});return;
 }
 if(!env.SMTP_HOST||!env.SMTP_FROM)throw Error('Account email delivery is not configured');
 const port=Number(env.SMTP_PORT||465);
 const transport=nodemailer.createTransport({host:env.SMTP_HOST,port,secure:port===465,requireTLS:port!==465,auth:env.SMTP_USER?{user:env.SMTP_USER,pass:env.SMTP_PASSWORD}:undefined,connectionTimeout:10000,socketTimeout:15000});
 await transport.sendMail({from:env.SMTP_FROM,to,subject,text:`${subject}\n\n${url}\n\nIf you did not request this, ignore this email.`});
}
