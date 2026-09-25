import * as v from 'valibot'

export const SubmissionParams = v.object({ id: v.pipe(v.string(), v.uuid()) })

/** Validation failures as a 400 naming each offending field. */
export const BAD_INPUT = {
  onError: (result: {
    issues: readonly { message: string; path?: readonly (PropertyKey | { key: PropertyKey })[] }[]
  }) => ({
    status: 400,
    message: result.issues
      .map(
        (issue) =>
          `${issue.path?.map((p) => String(typeof p === 'object' ? p.key : p)).join('.') ?? 'input'}: ${issue.message}`,
      )
      .join('; '),
  }),
}
