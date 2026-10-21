export async function verifyNextSession(job,connection){
 if(!connection?.baseUrl||!job.sessionId)throw Error('本次会话连接尚未登记，不能执行下条');
 const get=async route=>{
  const response=await fetch(connection.baseUrl.replace(/\/$/,'')+route,{headers:{Authorization:'Basic '+btoa(connection.opencodeUsername+':'+connection.opencodePassword)},signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw Error('核对当前模型状态失败 HTTP '+response.status);
  return response.json();
 };
 const session=await get('/session/'+job.sessionId);
 if(session.id!==job.sessionId||!session.directory)throw Error('当前会话归属无法确认');
 const query='?directory='+encodeURIComponent(session.directory);
 const [states,permissions,questions]=await Promise.all(['/session/status','/permission','/question'].map(route=>get(route+query)));
 if(!states||typeof states!=='object'||Array.isArray(states)||!Array.isArray(permissions)||!Array.isArray(questions))throw Error('当前会话状态格式异常');
 if([...permissions,...questions].some(p=>p.sessionID===job.sessionId))throw Error('当前任务等待审批或回答，请先处理交互');
 if(!['busy','retry'].includes(states[job.sessionId]?.type))throw Error('当前模型已空闲，等待脚本完成结果核验后再执行');
}
