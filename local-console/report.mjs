import {approvalLabels} from './policy.mjs';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const status={PASS:'通过',FAIL:'失败',BLOCKED:'阻塞',RUNNING:'执行中',EXITED:'已退出（未声明断言结果）',INTERRUPTED:'控制台已中断',RESUMED:'续跑完成',CHECKED:'检查通过（未完整执行）'};
status.STOPPED='已强制停止';
status.REVIEW='已观察·待复核';
const time=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'—';
export function renderReport(job){
 const r={...(job.result||{}),sessionId:job.result?.sessionId||job.sessionId},c=job.config||{};
 const permission=r.suite==='permission'||job.suite==='permission';
 if(job.status==='STOPPED')r.error=job.error;
 const evidence=r.evidence||[],events=[...(r.events||[])];
 if(r.observation){
  const o=r.observation;
  events.unshift({time:r.startedAt||job.startedAt,step:'权限行为观察',detail:[o.behavior,o.reason,'后续工具执行：'+(o.continuedAfterDecision===true?'已观察到':o.continuedAfterDecision===false?'未观察到':'无拒绝步骤'),'目标工具调用：'+o.targetToolCalls,'权限问询：'+o.permissionCards,'观测链完整：'+(o.transportComplete?'是':'否，不能据此认定没有问询')].join('；')});
 }
 // New runs have exact timestamps; old evidence retains its original capture order.
 const ordered=evidence.every(e=>e.time)?[...events.map(e=>({...e,kind:'event'})),...evidence.map(e=>({...e,kind:'image'}))].sort((a,b)=>a.time.localeCompare(b.time)):evidence.map(e=>({...e,kind:'image'}));
 const timeline=ordered.map((e,i)=>`<article><h3>${i+1}. ${esc(e.step)}</h3>${e.time?`<p class="hint">${esc(time(e.time))}</p>`:''}${e.kind==='image'?`<img loading="lazy" src="/artifacts/${encodeURIComponent(job.id)}/${encodeURIComponent(e.screenshot)}" alt="${esc(e.step)}">`:`<p>${esc(e.detail)}</p>`}</article>`).join('');
 const checks=r.checks||[],passed=checks.filter(x=>x.pass).length,rate=checks.length?`${passed}/${checks.length}（${Math.round(passed/checks.length*100)}%）`:'—';
 const links=(r.outputs||[]).map(o=>`<p><a download href="/artifacts/${encodeURIComponent(job.id)}/${encodeURIComponent(o.path)}">${esc(o.name)}</a></p>`).join('');
 const traceSection=`<section><h2>${permission?'Trace 与权限行为证据':'Trace 与 Skill 调用核验'}</h2><p><a href="/?trace=${encodeURIComponent(job.id)}">Trace 记录</a></p><p class="hint">${permission?'核对实际目标工具、权限卡、拒绝决策及后续执行；不要求固定回复或Skill调用。待复核不计为通过。':r.trace?'已按 '+esc(r.trace.ruleVersion)+' 核验真实 Skill 调用，结果计入本次断言。':'本记录未包含新版 Skill 调用断言；Trace 页可另行核验已有日志，原报告结论保持不变。'}</p>${r.trace?.error?'<p class="result-fail">'+esc(r.trace.error)+'</p>':''}</section>`;
 const recoverySection=job.handoff?`<section><h2>执行后的会话收尾</h2><p>${esc(job.recoveryAction||'已检查页面交接')}</p><p class="${job.handoff.ready?'':'result-fail'}">${esc(job.handoff.reason)}</p><p class="hint">收尾状态不改写以上用例结果及当时断言。</p></section>`:'';
 const video=job.recording;
 const videoState={STARTING:'正在启动',RECORDING:'录制中',FINALIZING:'保存中',COMPLETED:'已保存',ERROR:'录制失败',DISABLED:'未开启',SKIPPED:'只读预检不录制',INTERRUPTED:'录制中断'};
 const videoSection=video?`<section><h2>执行录像</h2><p>${esc(videoState[video.status]||video.status)}${video.stopReason==='limit'?' · 达到录像时长上限，用例继续执行':''}</p><p>${esc(video.config?.resolution||'')} · ${esc(video.config?.fps||'')} 帧/秒 · 目标 ${esc(video.config?.bitrateKbps||'')} kbps · 上限 ${esc(video.config?.maxSeconds||'')} 秒</p>${video.available?`<video class="execution-video" controls preload="metadata" src="/recordings/${encodeURIComponent(job.id)}"></video><p><a download href="/recordings/${encodeURIComponent(job.id)}/download">下载执行录像（MP4）</a> · ${esc(video.durationSeconds)} 秒 · ${(video.bytes/1000000).toFixed(2)} MB</p>`:''}${video.error?`<p class="result-fail">${esc(video.error)}</p>`:''}${video.visibilityWarning?`<p>${esc(video.visibilityWarning)}</p>`:''}<p class="hint">仅记录MobileWork页面，无声音。视频输出帧率包含静止重复帧；录像状态不改变用例断言结果。</p></section>`:'';
 const artifacts=videoSection+recoverySection+traceSection+(links?`<section><h2>真实产物</h2>${links}</section>`:'');
 const resultClass=['FAIL','BLOCKED','STOPPED','INTERRUPTED'].includes(job.status)?'result-fail':['PASS','CHECKED','RESUMED'].includes(job.status)?'result-pass':'';
 const outcome=permission?`<h3>行为观察结果</h3><p>${esc(r.observation?.behavior||'尚无完整观察')}</p><p>${esc(r.observation?.reason||r.error||'预检不产生业务结论')}</p><p class="hint">此结论仅覆盖本次实际触发分支；不以未调用目标工具或模型文字代替安全通过。风险等级、完整卡片字段及授权范围需要独立验证。</p>`:`<h3>断言结果</h3>${checks.map(x=>`<p class="${x.pass?'result-pass':'result-fail'}">${x.pass?'通过':'失败'}：${esc(x.name)}${x.actual!==undefined?' · '+esc(typeof x.actual==='string'?x.actual:JSON.stringify(x.actual)):''}</p>`).join('')||'<p>尚无断言结果，不能据此判定通过。</p>'}`;
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.title||job.name)} · 执行报告</title><link rel="stylesheet" href="/style.css"></head><body>
 <nav class="detail-return"><a href="/#scriptSection">← 返回脚本列表</a>${job.batchId?`<a href="/?batch=${encodeURIComponent(job.batchId)}">返回执行批次</a>`:''}</nav>
 <main class="report"><header><div><small>MOBILEWORK · TEST REPORT</small><h1>${permission?'权限行为观察报告':'测试用例执行报告'}</h1><p>${esc(r.title||job.name)}</p></div><span class="badge ${resultClass}">${esc(status[job.status]||job.status)}</span></header>
 <section><h2>用例与执行结果</h2><p>用例：${esc(r.caseId||job.name)} · ${esc(r.sheet||'')}${r.row?' · 第 '+esc(r.row)+' 行':''}</p><p>开始：${esc(time(job.startedAt))}　结束：${esc(time(job.endedAt))}（北京时间）</p><p>执行结果：<span class="${resultClass}">${esc(status[job.status]||job.status)}</span>${permission?'':'　断言通过率：'+rate}</p>
 <p>会话：${r.sessionId?`${esc(r.sessionId)}　<a href="/sessions/${encodeURIComponent(r.sessionId)}/download">下载 Session 日志</a>`:'未创建'}</p><p>执行模式：${esc(r.mode||'完整执行')}　原表差异：${esc(r.note||'无')}</p><p>范围：${esc(r.scope||'以脚本断言为准')}</p><p>错误或阻塞：${esc(r.error||job.error||'无')}</p>
 <h3>本次执行参数</h3><p>选项：${esc({first:'第一项',second:'第二项',custom:'自定义'}[c.question])}　审批：${esc(permission?'固定拒绝并继续观察（覆盖全局审批选项）':approvalLabels[c.approval])}　模型：${esc(c.model||'沿用客户端当前模型')}</p>${c.question==='custom'?`<p>自定义内容：${esc(c.customText)}</p>`:''}<p class="hint">交互等待间隔：${esc(c.stepInterval??0.5)} 秒；核对本会话请求归属后处理。</p>${outcome}</section>
 <section><h2>执行过程与截图（按发生顺序）</h2>${timeline||'<p>尚无步骤截图。</p>'}</section>${artifacts}<section><h2>完整执行日志</h2><pre>${esc(job.log||events.map(e=>`${e.time} ${e.step} ${e.detail||''}`).join('\n')||'暂无日志')}</pre></section></main></body></html>`;
}
