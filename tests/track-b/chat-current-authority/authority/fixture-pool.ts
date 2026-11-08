export const fixtureDatabase: { db: any; queries: Array<{sql:string;params?:unknown[]}>; afterQuery?: (sql:string)=>Promise<void> } = {db:null,queries:[]};
export class Pool {
 constructor(_options:unknown){}
 async query(sql:string,params?:unknown[]){fixtureDatabase.queries.push({sql,params});const result=await fixtureDatabase.db.query(sql,params);await fixtureDatabase.afterQuery?.(sql);return result;}
 async connect(){return {query:(sql:string,params?:unknown[])=>this.query(sql,params),release(){}};}
}
