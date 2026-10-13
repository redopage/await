// An ordered method + path table for a Durable Object's internal requests. In a path, `:name`
// captures one non-empty segment and a final `*` matches anything below the prefix. The first route
// whose method and path both match answers; a '*' method matches every method, including HEAD.
// Routes match the raw segments and only then decode the params, once, so an encoded `/` in a value
// can never select another route. A malformed escape throws a URIError.
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | '*';
export type Route<H> = readonly [method: Method, path: string, handler: H];
export type RouteMatch<H> = { handler: H; params: Record<string, string> };

export class Router<H> {
  private readonly routes: { method: Method; segments: string[]; prefix: boolean; handler: H }[];

  constructor(routes: readonly Route<H>[]) {
    this.routes = routes.map(([method, path, handler]) => {
      const segments = path.split('/').slice(1);
      const prefix = segments.at(-1) === '*';
      return { method, segments: prefix ? segments.slice(0, -1) : segments, prefix, handler };
    });
  }

  match(method: string, pathname: string): RouteMatch<H> | null {
    const parts = pathname.split('/').slice(1);
    for (const route of this.routes) {
      if (route.method !== '*' && route.method !== method) continue;
      if (route.prefix ? parts.length <= route.segments.length : parts.length !== route.segments.length) continue;
      const params: Record<string, string> = {};
      const matched = route.segments.every((segment, index) => {
        if (!segment.startsWith(':')) return segment === parts[index];
        params[segment.slice(1)] = parts[index];
        return parts[index] !== '';
      });
      if (!matched) continue;
      for (const name in params) params[name] = decodeURIComponent(params[name]);
      return { handler: route.handler, params };
    }
    return null;
  }
}
