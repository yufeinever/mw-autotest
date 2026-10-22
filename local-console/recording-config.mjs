export const recordingDefaults={enabled:true,resolution:'960x540',fps:30,bitrateKbps:600,maxSeconds:180};
export const recordingResolutions=['640x360','960x540','1280x720'];
export const recordingFrameRates=[10,15,24,30];
export const recordingBitrates=[300,400,600,800,1000,1500,2000];
export function normalizeRecording(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('录像配置无效');
 const result={...recordingDefaults,...input};
 if(typeof result.enabled!=='boolean')throw Error('录像开关无效');
 result.fps=Number(result.fps);result.bitrateKbps=Number(result.bitrateKbps);result.maxSeconds=Number(result.maxSeconds);
 if(!recordingResolutions.includes(result.resolution))throw Error('录像分辨率无效');
 if(!recordingFrameRates.includes(result.fps))throw Error('录像帧率无效');
 if(!recordingBitrates.includes(result.bitrateKbps))throw Error('录像码率无效');
 if(!Number.isInteger(result.maxSeconds)||result.maxSeconds<10||result.maxSeconds>180)throw Error('录像上限必须为10～180秒');
 return Object.fromEntries(Object.keys(recordingDefaults).map(key=>[key,result[key]]));
}
