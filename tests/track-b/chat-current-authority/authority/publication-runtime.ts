export const runtimeFixture: {app: any}={app:undefined};
export const currentAutonomy=()=>runtimeFixture.app;
export const autonomyUnavailable=()=>Response.json({error:'fixture not installed'},{status:503});
