export async function richModeStep(): Promise<boolean> {
  "use step";
  return process.env.EVAL_SERVICES === "real";
}
