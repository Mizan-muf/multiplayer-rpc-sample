import { createAppServer } from "./server.js";

const port = Number(process.env.PORT ?? 3001);
const { server } = createAppServer();

server.listen(port, () => {
  console.log(`Rock Paper Scissors server listening on http://localhost:${port}`);
});