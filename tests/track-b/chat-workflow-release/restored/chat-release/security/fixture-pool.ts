export const fixtureDatabase: { db: any; queries: Array<{sql:string;params?:unknown[]}> } = {db:null,queries:[]};
export class Pool {
 constructor(_options:unknown){}
 query(sql:string,params?:unknown[]){fixtureDatabase.queries.push({sql,params});return fixtureDatabase.db.query(sql,params);}
 async connect(){return {query:(sql:string,params?:unknown[])=>this.query(sql,params),release(){}};}
}
