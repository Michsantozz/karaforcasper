import { Mastra } from "@mastra/core";
import { casperAgent } from "./agents/casper.agent";
import { autonomousWorkflow } from "./workflows/autonomous.workflow";

export const mastra = new Mastra({
  agents: { casperAgent },
  workflows: { autonomousWorkflow },
});
