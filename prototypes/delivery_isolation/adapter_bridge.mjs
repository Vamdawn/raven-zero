// THROWAWAY acceptance bridge; production owns lifecycle and publication.
import {createInterface} from 'node:readline';
const {CodexSession, recoverPublication} = await import(process.argv[2]);
let session;
const input=createInterface({input:process.stdin});
for await(const line of input) {
 try {
  const request=JSON.parse(line);let result;
  switch(request.operation) {
   case 'open': session=await CodexSession.open(request.options);result={thread:session.thread,endpoint:session.nativeEndpoint,scope:session.scope,modelScope:session.modelScope};break;
   case 'turn': result=await session.startTurn(request.params);break;
   case 'finish': result=await session.finish();break;
   case 'status': result={pending:session.unresolvedRequests};break;
   case 'cancel': result=await session.cancel();break;
   case 'archive': await session.archive();result={archived:true};break;
   case 'recover': result=await recoverPublication(request.delivery,request.identity);break;
   default:throw new Error('Unknown bridge operation');
  }
  process.stdout.write(JSON.stringify({id:request.id,result})+'\n');
 } catch(error) {process.stdout.write(JSON.stringify({error:error.message,detail:error.cause?.cause?.message??error.cause?.message})+'\n');}
}
if(session) await session.cancel();
