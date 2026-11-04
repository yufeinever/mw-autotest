import http from 'node:http';

const projectRoot=process.env.MW_RESTART_TEST_ROOT;
const dataDir=process.env.MW_RESTART_TEST_DATA;
if(!projectRoot||!dataDir)throw Error('Missing isolated test directory');
const isNew=process.argv.includes('--no-open');
const server=http.createServer(async(req,res)=>{
 if(req.url==='/api/state')return res.end(JSON.stringify({projectRoot,instanceId:isNew?'new-instance':'old-instance',pid:process.pid}));
 if(isNew&&req.url==='/stop'){res.end('stopped');server.close();server.closeIdleConnections?.();return;}
 if(!isNew&&req.url==='/restart'){
  const {prepareConsoleRestart}=await import(process.env.MW_RESTART_TEST_MODULE);
  const restart=await prepareConsoleRestart({port:server.address().port,projectRoot,dataDir,instanceId:'old-instance'});
  res.once('finish',()=>{process.disconnect?.();restart.shutdown(server);});res.end('restarting');return;
 }
 res.writeHead(404);res.end();
});
server.listen(isNew?Number(process.env.MW_CONSOLE_PORT):0,'127.0.0.1',()=>{if(!isNew)process.send({port:server.address().port});});
