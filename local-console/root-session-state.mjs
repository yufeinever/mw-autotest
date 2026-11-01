// Shared with the browser; keep transport, filesystem and Node APIs out.
export const isRootSessionJob=job=>job.rootSessionVersion===1;
export const hasUnresolvedRoots=job=>isRootSessionJob(job)&&Boolean(job.pendingSubmission||job.rootSessions?.some(root=>!root.modelCompleted&&!root.sessionSettled||!root.cleanupComplete));
export const publicRootState=({submittedText,resources,...root})=>root;
