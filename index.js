const asyncHooks = require('async_hooks')
const uuid = require('uuid')
const {NORMAL, SANDBOX, ROLLBACK} = require('./constants')

/** 
 *  Create a wrapper around pg-postgres that can capture references to transactions
 *  and trace async function calls.
 */

class Sandboxer {
  constructor(options = {}) {
    this.pg = options.pg
    this.mode = options.mode || NORMAL
    this.sandboxes = {}
    this.context = new Map()

    if (options.mode === SANDBOX ) {
      
      // With async_hooks, we can capture references to event and promise 
      // creation/destruction by id. Each async call has an id, and each 
      // function that triggers an async call has an id. 
      // 
      // We can store a reference to the initial trigger on every promise, and 
      // keep track of what "scope" our function is in. We can use this reference
      // to isolate our postgres transactions.

      asyncHooks.createHook({
        init: (asyncId, _type, triggerAsyncId) =>{
          if (this.context.has(triggerAsyncId)) {
            this.context.set(asyncId, this.context.get(triggerAsyncId))
          }
        },
        destroy: (asyncId) => {
          if (this.context.has(asyncId)) {
              this.context.delete(asyncId);
          }
        }
      }).enable()
    }
  }

  _getConn() {
    // if we're scoped within a sandbox, grab the sandbox client so we can
    // transparently add the next query to the sandboxed transaction, otherwise 
    // use the base database client.

    if (this.mode === NORMAL) return this.pg

    const id = this.context.get(asyncHooks.executionAsyncId())
    const found = this.sandboxes[id] 
    let conn = found ? found.tx : this.pg
    return conn
  }

  /**
   * Creates a transaction sandbox. Puts all database calls made within the 
   * "promise chain"/async function stack into the current transaction.
   */
  createSandbox() {
    const id = uuid.v4()
    this.context.set(asyncHooks.executionAsyncId(), id)

    const grabTransactionReference = (callback) => (tx) => new Promise((_, rollback)=> {
      this.sandboxes[id] = { tx, rollback }
      callback(id)
    })


    return new Promise((resolve, reject) => {
      let resolved = false
      this.pg.tx(grabTransactionReference((id) => { 
        resolved = true
        resolve(id) 
      }))
      .catch((err) => {
        if (!resolved || err !== ROLLBACK) {
          reject(err)
        }

      })
    })
  }

  /**
   * Closes a transaction sandbox, rolling back all changes.
   */
  async closeSandbox() {
    const id = this.context.get(asyncHooks.executionAsyncId());
    const conn = this.sandboxes[id]
    if (!conn) return this
    
    await conn.rollback(ROLLBACK)

    delete this.sandboxes[id]
    return this
  }

}


/**
 * Wrap up your pg-promise client with a sandbox mode.
 * 
 * @param {*} options - an object of options.
 * @param options.pg - your pg-promise client, initalized.
 * @param options.mode - Either 'normal' or 'sandbox'. 'normal' mode does not 
 * initialize async_hooks.
 * @returns {pgPromise.IDatabase<{}, pg.IClient>} a wrapped pg promise client.
 */
const pgSandbox = (options) => {
  const sandbox = new Sandboxer(options)
  const handler = {
    get(target, name, reciever) {
      if (!Reflect.has(target, name)) {
        const conn = target._getConn()
        return Reflect.get(conn, name, reciever)  
      }
      return Reflect.get(target, name, reciever)
    }
  }

  return new Proxy(sandbox, handler)
}
module.exports = { pgSandbox }