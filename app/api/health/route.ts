export const dynamic='force-dynamic';
export async function GET(){return Response.json({status:'ok',service:'winnigo-web'},{headers:{'Cache-Control':'no-store'}});}
