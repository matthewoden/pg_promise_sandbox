# PG Promise Sandbox

An experiment with pg-postgres to turn database tests into an embarassingly
parallel problem. This library wraps pg-postgres in a way that enables a sandbox
that runs each test in a transaction, so every single test can be run in
isolation, and also in parallel.

Currently unpublished, pending further testing.

## Requirements

- `pg-promise@10.x` is a peer dependency.

## Usage

If you're already using pg-promise, then this library shouldn't change the way
your app runs at all (see below for exceptions). I've used a proxy to copy every
single property of pg-promise, allowing this to be a drop-in addition
to any codebase.

Two new functions are added to pg-promise's, and are needed to enable sandbox-mode:

- `createSandbox (Promise: void)` - creates a transaction, and begins all
  subsequent promises to the task
- `closeSandbox (Promise: void)` - closes the transaction.

### Wrapping PG Promise

Simply pass in your existing pg-promise instance, and whether or not sandbox mode
should be enabled.

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

The following example could be used to run mocha tests with --parallel, or by
spinning up multiple mocha instances (and multiple cores) via `find ./test --name='*Spec.js | xargs -P 4 mocha`

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

This could be even simpler. If you use a mocha setup file, you could set these
functions globally, and omit the beforeEach entirely.

```js
const db = require("./my/db/client");

global.beforeEach(() => db.createSandbox());
global.afterEach(() => db.restoreSandbox());
```

### When to use this plugin

Use this when your application is truly stateless per request.

If you need to rely on shared caches, or multiple databases for a single call,
this libray may not work as intended. Consider how you might disable, or mock
stateful functionality in your tests.

In addition, there are two pg-promise methods that the wrapped API doesn't support
well - `.txIf` and `.taskIf`.

By default, these methods use a transaction, depending on whether or not the call
is currently in a transaction. If everything is in a transaction by default,
this obviously isn't going to function as expected.

As a general rule - when you can't use a sandbox, move the test to a new file,
and test it seperately from everything else.

## Background

When writing a database test, we often create a scenario with a number of set up
queries, assert on our data's state, and then clean up our database for the
next test.

Similarly, when updating a database we use a transaction, grouping multiple queries
together, and if all our queries resolve, we commit our changes. If we end up in
bad state, we can roll it back.

These are pretty similar operations. Our tests are basically just transactions
except we roll back no matter what. So why not put our test code in a transaction?
We get automatic cleanup, and our test data is fully isolated. If our app is also
stateless, that means we can run all our database tests concurrently!

We just have to create a transaction at the start of a test, inject our queries
into that specific transaction, then rollback when our tests are done.

Making this work is a little tricky. Postgres only sort-of allows for nested
transactions. There's a top level transaction, and then named savepoints when
within a transaction. So that means "nesting transactions" requires conditional
rewriting of SQL.

Foruntately, the pg-promise has a wonderful transactions API, allowing developers
to write composable queries that don't need know if they're in a transaction or
not.

The next problem: how do we know which transaction to use? In a threaded
language we could check out a database connection, start a transaction, and
assign ownership of that transaction to a thread. Any query run in that
thread would reuse that connection. But Node.js is single threaded, so all our
connections are running in shared memory, and rotating in and out of the event
loop.

This issue can be resolved with async_hooks. It provides an API to trace async
functions, granting callbacks that fire when a promise chain starts, with
information around what process invoked it. Which means instead of threads, we
can assign a transaction to a promise chain.

## Roadmap

- Expand testing strategy without deeply relying on pg-promise private properties.
- determine strategy for txIf and taskIf to allow a single level of nesting.
