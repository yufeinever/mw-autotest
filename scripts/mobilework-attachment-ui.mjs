import {attachmentRow} from './mobilework-composer-resources.mjs';

// Ownership is registered before opening the product's actual file chooser.
export async function uploadTaskAttachment(page,{file,name,resources,checkpointResources,capture}){
 resources.attachments.push(name);await checkpointResources();
 const upload=()=>page.getByRole('button',{name:'上传文件',exact:true}).filter({visible:true});
 await upload().click();
 const chosen=page.waitForEvent('filechooser');await upload().last().click();
 await (await chosen).setFiles(file);await attachmentRow(page,name).waitFor();
 await capture('上传材料-'+name);
}
