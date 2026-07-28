import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import type * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { apiConnectorCapabilities, type ApiConnectorShape } from "../Connector.ts"
import type { LlmError } from "../Errors.ts"
import type { StructuredResult } from "../LlmService.ts"
import {
  ConnectorIds,
  HealthStatus,
  LlmChunk,
  TokenUsage,
  ToolCallResponse,
  type JsonSchema,
  type LlmConfig,
  type Message
} from "../Models.ts"
import { parseFromText } from "../StructuredOutput.ts"

export const mockResponse = (): string =>
  "This is a mock response from the demo AI provider. " +
  "The mock provider simulates LLM output without making any real API calls. " +
  "All features work normally except AI-generated content is replaced with pre-canned responses."

interface MockIssueTemplate {
  readonly title: string
  readonly tags: ReadonlyArray<string>
  readonly capabilities: ReadonlyArray<string>
  readonly criteria: ReadonlyArray<string>
  readonly body: string
}

const issueTemplates: ReadonlyArray<MockIssueTemplate> = [
  {
    title: "Set up Spring Boot project scaffold",
    tags: ["setup", "bootstrap"],
    capabilities: ["java", "spring-boot"],
    criteria: [
      "Maven/Gradle build compiles",
      "Application starts on port 8080",
      "Health endpoint returns 200"
    ],
    body:
      "Initialize the Spring Boot 3.x project with Java 21, configure build tool, " +
      "and add Actuator health endpoint."
  },
  {
    title: "Implement REST controller for orders",
    tags: ["rest", "api"],
    capabilities: ["java", "spring-boot", "rest"],
    criteria: [
      "GET /api/orders returns list",
      "POST /api/orders creates order",
      "Validation errors return 400"
    ],
    body: "Create OrderController with CRUD endpoints, request validation, and proper HTTP status codes."
  },
  {
    title: "Add JPA entity and repository for Order",
    tags: ["database", "jpa"],
    capabilities: ["java", "spring-data"],
    criteria: [
      "Order entity maps to orders table",
      "Repository supports findByStatus",
      "Flyway migration creates schema"
    ],
    body: "Define Order JPA entity with audit fields, OrderRepository interface, and initial Flyway migration script."
  },
  {
    title: "Configure Spring Security with JWT authentication",
    tags: ["security", "auth"],
    capabilities: ["java", "spring-security"],
    criteria: [
      "Unauthenticated requests return 401",
      "Valid JWT grants access",
      "Tokens expire after configured TTL"
    ],
    body: "Set up Spring Security filter chain with JWT validation, configure public and protected endpoints."
  },
  {
    title: "Write unit tests for OrderService",
    tags: ["testing", "unit-test"],
    capabilities: ["java", "testing"],
    criteria: [
      "Service methods have test coverage",
      "Edge cases tested",
      "Mocks used for repository layer"
    ],
    body: "Create JUnit 5 tests for OrderService using Mockito for repository dependencies."
  },
  {
    title: "Add pagination and sorting to list endpoints",
    tags: ["rest", "api"],
    capabilities: ["java", "spring-boot"],
    criteria: [
      "GET /api/orders supports page and size params",
      "Sort by createdAt default",
      "Response includes total count"
    ],
    body: "Implement Spring Data Pageable support in OrderController with proper response envelope."
  },
  {
    title: "Set up Docker container and Compose file",
    tags: ["devops", "docker"],
    capabilities: ["docker", "devops"],
    criteria: [
      "Dockerfile builds multi-stage image",
      "docker-compose starts app with PostgreSQL",
      "Container health check passes"
    ],
    body: "Create optimized multi-stage Dockerfile and docker-compose.yml with PostgreSQL service."
  },
  {
    title: "Implement global exception handler",
    tags: ["rest", "error-handling"],
    capabilities: ["java", "spring-boot"],
    criteria: [
      "Validation errors return structured response",
      "404 returns proper body",
      "500 errors are logged"
    ],
    body: "Create @ControllerAdvice with handlers for common exceptions, returning consistent error response format."
  },
  {
    title: "Add integration tests with TestContainers",
    tags: ["testing", "integration"],
    capabilities: ["java", "testing", "docker"],
    criteria: [
      "Tests run against real PostgreSQL",
      "Database is reset between tests",
      "CI pipeline can run tests"
    ],
    body: "Set up TestContainers with PostgreSQL for integration testing, create base test class with shared container."
  },
  {
    title: "Configure structured logging with correlation IDs",
    tags: ["observability", "logging"],
    capabilities: ["java", "observability"],
    criteria: [
      "Logs include correlationId header",
      "JSON log format in production",
      "Request/response logged at DEBUG"
    ],
    body: "Set up Logback with JSON encoder, MDC-based correlation ID propagation via servlet filter."
  },
  {
    title: "Create OpenAPI specification",
    tags: ["documentation", "api"],
    capabilities: ["java", "documentation"],
    criteria: [
      "Swagger UI accessible at /swagger-ui",
      "All endpoints documented",
      "Schema examples included"
    ],
    body: "Add springdoc-openapi dependency, annotate controllers with OpenAPI annotations."
  },
  {
    title: "Implement rate limiting middleware",
    tags: ["security", "performance"],
    capabilities: ["java", "spring-boot"],
    criteria: [
      "Rate limit headers in response",
      "429 returned when exceeded",
      "Configurable per-endpoint limits"
    ],
    body: "Add Bucket4j-based rate limiting filter with configurable limits per endpoint."
  },
  {
    title: "Set up GitHub Actions CI pipeline",
    tags: ["devops", "ci"],
    capabilities: ["devops", "ci"],
    criteria: [
      "Build runs on push to main",
      "Tests execute in CI",
      "Docker image pushed on release"
    ],
    body: "Create GitHub Actions workflow for build, test, and Docker image publishing."
  },
  {
    title: "Add Actuator metrics and custom health indicators",
    tags: ["observability", "monitoring"],
    capabilities: ["java", "observability"],
    criteria: [
      "Custom health check for database",
      "Business metrics exposed",
      "Prometheus endpoint available"
    ],
    body: "Configure Actuator with Prometheus exporter, add custom HealthIndicator and MeterBinder implementations."
  },
  {
    title: "Implement order status workflow",
    tags: ["business-logic", "workflow"],
    capabilities: ["java", "spring-boot"],
    criteria: [
      "Status transitions are validated",
      "Invalid transitions return 422",
      "Status history is tracked"
    ],
    body: "Create OrderStatusMachine with allowed transitions, persist status change events."
  }
]

const mockIssue = (index: number): Readonly<Record<string, unknown>> => {
  const template = issueTemplates[(index - 1) % issueTemplates.length]
  return {
    id: `demo-issue-${index}`,
    title: template?.title ?? "",
    priority: index <= 3 ? "high" : index <= 7 ? "medium" : "low",
    assignedAgent: null,
    requiredCapabilities: template?.capabilities ?? [],
    blockedBy: [],
    tags: template?.tags ?? [],
    acceptanceCriteria: template?.criteria ?? [],
    estimate: "2h",
    proofOfWork: ["diff-stat"],
    body: template?.body ?? ""
  }
}

const requestedIssueCount = (prompt: string): number => {
  const matched = /(\d+)\s*issue/i.exec(prompt)?.[1]
  return Math.min(matched === undefined ? 10 : Number(matched), 100)
}

export const mockStructuredResponse = (prompt: string, schema: JsonSchema): string => {
  const schemaText = JSON.stringify(schema)
  if (schemaText.includes('"summary"') && schemaText.includes('"issues"')) {
    const count = requestedIssueCount(prompt)
    return JSON.stringify({
      summary: `Generated ${count} issue drafts for Spring Boot microservice demo.`,
      issues: Array.from({ length: count }, (_, index) => mockIssue(index + 1))
    })
  }
  return JSON.stringify({
    result: "mock structured response"
  })
}

const lastUserPrompt = (messages: ReadonlyArray<Message>): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "User") {
      return message.content
    }
  }
  return ""
}

export const makeMockProvider = (config: LlmConfig): ApiConnectorShape => {
  const executeStructuredWithUsage = <A, E, RD, RE>(
    prompt: string,
    schema: Schema.ConstraintCodec<A, E, RD, RE>,
    jsonSchema: JsonSchema
  ): Effect.Effect<StructuredResult<A>, LlmError, RD> =>
    Effect.gen(function* () {
      const value = yield* parseFromText(
        mockStructuredResponse(prompt, jsonSchema),
        schema,
        jsonSchema
      )
      const result: StructuredResult<A> = [value, undefined, undefined]
      return result
    })

  const executeStream = (_prompt: string): Stream.Stream<LlmChunk, LlmError> => {
    const words = mockResponse().split(" ")
    return Stream.fromIterable(
      words.map((word, index) => {
        const last = index === words.length - 1
        return LlmChunk.make({
          delta: `${index === 0 ? "" : " "}${word}`,
          metadata: {
            provider: "mock",
            model: config.model
          },
          ...(last ? { finishReason: "stop" } : {}),
          ...(last
            ? {
                usage: TokenUsage.make({
                  prompt: 10,
                  completion: words.length,
                  total: 10 + words.length
                })
              }
            : {})
        })
      })
    ).pipe(Stream.schedule(Schedule.spaced(Duration.millis(50))))
  }

  return {
    id: ConnectorIds.Mock,
    kind: "Api",
    capabilities: apiConnectorCapabilities(),
    healthCheck: Effect.succeed(
      HealthStatus.make({
        availability: "Healthy",
        authStatus: "Valid",
        latency: Duration.zero
      })
    ),
    executeStream,
    executeStreamWithHistory: (messages) => executeStream(lastUserPrompt(messages)),
    executeWithTools: (_prompt) =>
      Effect.succeed(
        ToolCallResponse.make({
          content: mockResponse(),
          toolCalls: [],
          finishReason: "stop"
        })
      ),
    executeStructured: <A, E, RD, RE>(
      prompt: string,
      schema: Schema.ConstraintCodec<A, E, RD, RE>,
      jsonSchema: JsonSchema
    ): Effect.Effect<A, LlmError, RD> =>
      Effect.map(executeStructuredWithUsage(prompt, schema, jsonSchema), ([value]) => value),
    executeStructuredWithUsage,
    isAvailable: Effect.succeed(true)
  }
}
