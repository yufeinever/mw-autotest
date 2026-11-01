import fs from 'node:fs/promises';
import path from 'node:path';
import {openCanvas} from './client-kanban-steps.mjs';
import {readWeatherBaseline,weatherChecks,windDisplay} from './mobilework-weather-baseline.mjs';

const save=(c,name,value)=>fs.writeFile(path.join(c.dir,name+'.json'),JSON.stringify(value,null,2));
const review=message=>Object.assign(Error(message),{review:true});
export async function runWeatherSteps(context,{call,before}){
 const candidates=[];
 // The actual efficiency canvas may lack a builtin flag. Match its real source,
 // then retain the original widget and view state instead of creating a fake.
 for(const board of before.filter(b=>b.title==='效率工具')){
  const detail=await call('/canvases/'+board.canvasId);
  for(const placement of detail.placements){const source=await call('/widgets/'+placement.widgetId+'/page');if(source.html.includes('api.open-meteo.com/v1/forecast')&&source.html.includes('id="cur-temp"'))candidates.push({board,detail,placement});}
 }
 if(candidates.length!==1)throw review('未找到唯一真实天气组件，不复制模板冒充内置天气');
 const {board,detail,placement}=candidates[0];
 const [response]=await Promise.all([context.page.waitForResponse(async response=>{
  const url=new URL(response.url());if(url.hostname!=='api.open-meteo.com'||url.pathname!=='/v1/forecast')return false;
  const frame=response.frame();if(frame.parentFrame()!==context.page.mainFrame())return false;
  return (await frame.frameElement()).getAttribute('data-widget-id').then(id=>id===placement.widgetId);
 },{timeout:20000}),openCanvas(context,{...board,placements:detail.placements})]);
 context.assert('本轮真实天气响应成功而非仅缓存',response.ok());
 const data=await response.json(),at=Date.now(),cur=data.current,daily=data.daily,url=new URL(response.url()),frame=context.page.locator('iframe[data-widget-id="'+placement.widgetId+'"]').contentFrame();await frame.locator('#city').waitFor({state:'visible'});
 context.assert('实时响应字段和计量单位完整',Number.isFinite(cur.temperature_2m)&&Number.isFinite(cur.relative_humidity_2m)&&Number.isFinite(cur.wind_speed_10m)&&Number.isFinite(cur.wind_direction_10m)&&data.current_units.wind_speed_10m==='km/h'&&daily.time.length>0);
 const measuredAt=Date.parse(cur.time+'Z')-data.utc_offset_seconds*1000;context.assert('实时天气测量时间在一小时内',Number.isFinite(measuredAt)&&Math.abs(at-measuredAt)<=3600000);
  const temp=Math.round(cur.temperature_2m)+'°';await frame.locator('#cur-temp').filter({hasText:temp}).waitFor();const city=await frame.locator('#city').innerText(),meta=await frame.locator('#cur-meta').innerText(),today=frame.locator('#forecast .fc-item').first();
  context.assert('温湿度及风向风力回显本轮响应',await frame.locator('#cur-temp').innerText()===temp&&meta.includes('湿度'+cur.relative_humidity_2m+'%')&&meta.includes(windDisplay(cur.wind_speed_10m,cur.wind_direction_10m)));
  context.assert('当天温度范围来自同一次预报',await today.locator('.lo').innerText()===Math.round(daily.temperature_2m_min[0])+'°'&&await today.locator('.hi').innerText()===Math.round(daily.temperature_2m_max[0])+'°');
  const issues=[],fact=await readWeatherBaseline();if(fact){context.assert('独立天气观测同城市与请求坐标',fact.city===city&&Math.abs(Number(url.searchParams.get('latitude'))-fact.latitude)<0.1&&Math.abs(Number(url.searchParams.get('longitude'))-fact.longitude)<0.1);for(const [key,pass] of Object.entries(weatherChecks(data,fact)))context.assert('独立天气数值及合理误差：'+key,pass);}else issues.push('缺独立气象观测及合理误差，实时响应与UI一致不能证明外部天气准确');
  issues.push('当前组件展示风力等级而非数值风速，原表风速目标保留；没有手动刷新入口，仅每小时自动刷新，未改时钟或伪造刷新');
 await save(context,'天气本轮响应与独立观测',{widgetId:placement.widgetId,canvasId:board.canvasId,city,responseAt:new Date(at).toISOString(),forecastTime:cur.time,requestCoordinates:{latitude:Number(url.searchParams.get('latitude')),longitude:Number(url.searchParams.get('longitude'))},current:cur,today:{minimum:daily.temperature_2m_min[0],maximum:daily.temperature_2m_max[0]},independent:fact,issues});await context.capture('真实天气温湿度范围及风向风力');context.remaining.delete('本轮真实天气响应与界面字段');if(fact)context.remaining.delete('独立天气合理误差与刷新边界');throw review(issues.join('；'));
}
