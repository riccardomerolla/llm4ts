import { createClient, Llm4tsError } from "@llm4ts/js/Client"

export const documentedMockExample = async (): Promise<string> => {
  const client = createClient({ provider: "mock", model: "mock" })
  try {
    return (await client.complete("Hello from JavaScript")).content
  } catch (error) {
    if (error instanceof Llm4tsError) {
      return `${error.category}: ${error.message}`
    }
    throw error
  }
}
