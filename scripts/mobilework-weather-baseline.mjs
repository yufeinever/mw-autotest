import fs from 'node:fs/promises';

export function windDisplay(speed,direction){
 const levels=[1,6,12,20,29,39,50,62,75,89,103,118],level=levels.findIndex(n=>speed<n);
 return ['北风','东北风','东风','东南风','南风','西南风','西风','西北风'][Math.round(direction/45)%8]+(level<0?12:level)+'级';
}
export function validateWeatherBaseline(value,now=Date.now()){
 if(value.source!=='independent-weather-observation'||!value.provider||/open.?meteo/i.test(value.provider)||!value.city||!Number.isFinite(value.latitude)||!Number.isFinite(value.longitude)||!Number.isFinite(Date.parse(value.observedAt))||Math.abs(now-Date.parse(value.observedAt))>3600000)throw Error('天气基线须来自独立来源，明确城市坐标且观测在一小时内');
 for(const key of ['temperature','minimum','maximum','humidity','windSpeed','windDirection'])if(!Number.isFinite(value[key]))throw Error('天气独立观测字段缺失：'+key);
 for(const key of ['temperature','humidity','windSpeed','windDirection'])if(!Number.isFinite(value.tolerance?.[key])||value.tolerance[key]<0)throw Error('天气合理误差须明确且非负：'+key);
 return value;
}
export async function readWeatherBaseline(){
 return process.env.MW_TEST_WEATHER_BASELINE?validateWeatherBaseline(JSON.parse(await fs.readFile(process.env.MW_TEST_WEATHER_BASELINE,'utf8'))):null;
}
export function weatherChecks(data,fact){
 const cur=data.current,daily=data.daily,t=fact.tolerance,delta=Math.abs(cur.wind_direction_10m-fact.windDirection)%360;
 return {temperature:Math.abs(cur.temperature_2m-fact.temperature)<=t.temperature,minimum:Math.abs(daily.temperature_2m_min[0]-fact.minimum)<=t.temperature,maximum:Math.abs(daily.temperature_2m_max[0]-fact.maximum)<=t.temperature,humidity:Math.abs(cur.relative_humidity_2m-fact.humidity)<=t.humidity,windSpeed:Math.abs(cur.wind_speed_10m-fact.windSpeed)<=t.windSpeed,windDirection:Math.min(delta,360-delta)<=t.windDirection};
}
