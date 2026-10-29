const RATE_LIMIT = 'rateLimit { cost remaining resetAt }';
const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
const ACTOR = 'author { __typename login }';
const REVIEW_FIELDS = `id state submittedAt ${ACTOR} comments { totalCount }`;

export const REPOSITORY_QUERY = `
query Repository($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    databaseId
    nameWithOwner
    defaultBranchRef { name }
    hasIssuesEnabled
    pullRequests { totalCount }
  }
  ${RATE_LIMIT}
}`;

export const PULL_REQUESTS_QUERY = `
query PullRequests($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, orderBy: {field: UPDATED_AT, direction: DESC}, after: $cursor) {
      ${PAGE_INFO}
      nodes {
        id number title state isDraft createdAt updatedAt mergedAt closedAt
        additions deletions changedFiles baseRefName
        ${ACTOR}
        mergedBy { __typename login }
        reviews(first: 30) {
          totalCount
          ${PAGE_INFO}
          nodes { ${REVIEW_FIELDS} }
        }
      }
    }
  }
  ${RATE_LIMIT}
}`;

export const PULL_REQUEST_REVIEWS_QUERY = `
query PullRequestReviews($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequest {
      reviews(first: 100, after: $cursor) {
        ${PAGE_INFO}
        nodes { ${REVIEW_FIELDS} }
      }
    }
  }
  ${RATE_LIMIT}
}`;

export const ISSUES_QUERY = `
query Issues($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, orderBy: {field: UPDATED_AT, direction: DESC}, after: $cursor) {
      ${PAGE_INFO}
      nodes {
        id number title state createdAt updatedAt closedAt
        ${ACTOR}
        labels(first: 20) { nodes { name } }
      }
    }
  }
  ${RATE_LIMIT}
}`;

export const COMMITS_QUERY = `
query Commits($owner: String!, $name: String!, $since: GitTimestamp, $until: GitTimestamp, $cursor: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 100, since: $since, until: $until, after: $cursor) {
            ${PAGE_INFO}
            nodes {
              oid committedDate additions deletions
              author { name email user { login } }
            }
          }
        }
      }
    }
  }
  ${RATE_LIMIT}
}`;
