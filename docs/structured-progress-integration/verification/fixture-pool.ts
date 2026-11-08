export const fixtureDatabase={query:async(_sql:string,_params?:unknown[]):Promise<{rows:unknown[]}>=>({rows:[]})};
export class Pool {constructor(_options:unknown){} query(sql:string,params?:unknown[]){return fixtureDatabase.query(sql,params);} async connect(){return {query:(sql:string,params?:unknown[])=>this.query(sql,params),release(){}};}}
