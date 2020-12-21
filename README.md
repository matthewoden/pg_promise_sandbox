# PG Promise Sandbox

An experiment with [pg-promise](https://github.com/vitaly-t/pg-promise) to turn database tests into an "embarrassingly parallel problem". I've extended the pg-promise API with a couple functions that move all queries per "test" into a transaction.

## Goals

By running each integration tests to run in a transaction, we can enable a faster feedback loop: Each test can be run concurrently with any other test. No data would ever be committed to the test database.

In turn, CI Pipelines could run also run concurrently. When a PR triggers an automatic test suite, it wouldn't need to wait for any other PR to finish. (Deployments would still need to be serial operations, of course.)

You can move as fast as your test-environment instance will allow.

## Installation

`pg-promise@10.x` is a peer dependency.

```shell
npm i pg-promise pg-promise-sandbox --save
```

## Usage

If you're already using `pg-promise`, then this library shouldn't change the way your app runs at all (see below for a few exceptions). I've used a proxy to copy every single property of pg-promise, allowing this to be a drop-in addition to most codebases.

Two new functions are added to pg-promise's, and are needed to enable sandbox-mode:

- `createSandbox (Promise: void)` - creates a transaction, and begins all
  subsequent promises to the task
- `closeSandbox (Promise: void)` - closes the transaction.

### Wrapping PG Promise

Simply pass in your existing pg-promise instance, and whether or not sandbox mode should be enabled.

```js
const pgpromise = require("pg-promise")();
const { pgSandbox } = require("pg-promise-sandbox");

const pg = pgpromise({
  username: "postgres",
  password: "postgres",
  port: 5432,
  database: "concurrent",
  ssl: false,
});

const mode = process.env.NODE_ENV === "test" ? "sandbox" : "normal";

module.exports = pgSandbox({ pg, mode });
```

### Testing Example

The following example could be used to run mocha tests with --parallel, or by spinning up multiple mocha instances (and multiple cores) via `find ./test --name='*Spec.js | xargs -P 4 mocha`

> Note: Slam your test-database responsibly.

```js
const db = require('./my/db/client')
const User = require('./my/user/module')

describe('User registration', () => {

  before(async () => {
    // check out a connection from the pool, begin a transaction.
    // all new queries are in a nested transaction.
    await db.createSandbox()
  })

  after(async () => {
    // rollback transaction, release connection.
    // nothing is actually committed to the database.
    await db.closeSandbox()
  })

  it('saves a user', () => {
    // can be run concurrently with any other test
    const user = await User.create({name: "Bob McBoberson III"})
    user.id.should.eql("bob-mcboberson-iii")
  })
})
```

This could be even simpler. If you use a mocha setup file, you could set these functions globally, and omit the beforeEach entirely.

```js
const db = require("./my/db/client");

global.beforeEach(() => db.createSandbox());
global.afterEach(() => db.restoreSandbox());
```

## When to use this library

Use this when your application:

- has a LOT of postgres integration tests
- has logic that is truly stateless, or can be made stateless.
- doesn't care about whether a query is in a transaction or not

As a general rule - when you can't use a sandbox, move the test to a new file,
and test serial operations seperately from everything else.

### Why test counts matter.

If you only have a small number of tests, or very simple tests, the overhead for starting a parallel CI process might take as much time as running your tests serially.

### Why stateless?

If your app hits multiple databases, like elasticsearch or redis, these will be shared across
tests, and may interfere with concurrent testing.

If you have an in-memory cache, you can probably get away with concurrent testing - possibly by creating a new cache per test.

It's left to the reader to consider how you might refactor, or mock stateful functionality in your tests. But always prefer confidence in your tests, over speed.

### Why not care about transactions?

There are two pg-promise methods that the wrapped API doesn't support well: `.txIf` and `.taskIf`.

By default, these methods use a transaction, depending on whether or not the call is currently in a transaction. Since this library wraps everything in a transaction by default, those queries obviously won't function as expected.

## Background

Node’s claim to fame is that it’s single-threaded concurrency model is super lightweight and perfect for network and IO heavy tasks. Yet the current state of database integration tests on node are this serial process of setup, assert, then teardown. We’re barely taking advantage of our runtime in our test environment.

In our CI pipelines, we have to wait on other jobs to finish before the next job can start.

Other, threaded languages have a workaround for this. When testing, they use nested transactions. Each test checks out a connection from the pool, spins up a transaction, and assigns that connection ownership to the test thread. All queries that originate from that thread use that transaction. When the test is done, they roll back the parent transaction. No data is committed. No tests share memory, and your tests can run as fast as your CI agent allows.

While we can’t do that with Node, we can get pretty close with the `async_hooks` module. It provides just enough functionality to create an async stack trace, and let us determine if a process is running in the scope, or “promise chain” of another promise. When we create a sandbox, we store a reference to the async scope, alongside a reference to a transaction.

Another requirement is one of syntax - postgres only sort-of supports nested transactions. After the top level transaction, postgres moves to a named savepoint syntax instead of additional transactions. So any transaction code would need SQL to be changed dynamically based on whether we're in a transaction yet or not.

The `pg-promise` library was chosen specificially because it handles this problem really well: the API allows developers to compose queries without caring if it’s in a transaction or not (which is why the `txIf` and `taskIf` api exists - because sometimes you have to care). By using a [Proxy](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy), we can check each database function call, look up which sandbox the current function belongs to, and inject the current query into the appropriate transaction.

## Roadmap

- Expand testing strategy without deeply relying on pg-promise private properties.
- determine strategy for txIf and taskIf to allow a single level of nesting.
