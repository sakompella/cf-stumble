export const ROUTE_FAILURE = {
  supervisorUnavailable: "network error: the supervisor did not answer the model route",
  routeUnreachable: "network error: the model route did not answer",
  streamInterrupted: "the model route's stream was interrupted before a result",
  unreadableReply: "the model route wrote a reply the facet cannot read",
  requestTooLarge: "request_too_large: the request exceeds the model route's 1 MiB size limit",
} as const;

export type RouteFailure = keyof typeof ROUTE_FAILURE;
