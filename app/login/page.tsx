import AccountLogin from '@/components/account-login';
export const dynamic='force-dynamic';
export default function LoginPage(){return <AccountLogin google={!!process.env.GOOGLE_CLIENT_ID&&!!process.env.GOOGLE_CLIENT_SECRET} mail={process.env.WINNIGO_MAIL_MODE==='file'||!!process.env.SMTP_HOST}/>;}
