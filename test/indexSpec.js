const { should } = require('chai')
const { pgSandbox } = require('../index.js')
const pg = require('../data/db')
require('./setup')



describe('Concurrent DB Client', () => {

  it('createSandbox scopes queries to a transaction, and rolls back upon complete.', async () => {
    const client = pgSandbox ({pg, mode: 'sandbox'})      
    const sandbox = await client.createSandbox()
    
    await client.query('insert into pg_promise_sandbox(data) values ($(text))', {text: "test"})
    const data1 = await client.query('select * from pg_promise_sandbox')
    
    await client.closeSandbox(sandbox)

    const data2 = await client.query('select * from pg_promise_sandbox')
    
    data1.length.should.eql(1)
    data2.should.eql([])
  })

  it('isolates sandboxes', async () => {
    const client = pgSandbox ({pg, mode: 'sandbox'})      
    const runInSandbox = async () => {
      await client.createSandbox()
    
      await client.query('insert into pg_promise_sandbox(data) values ($(text))', {text: "test"})
      const [data1, data2] = await Promise.all([client.query('select * from pg_promise_sandbox'), client.query('select * from pg_promise_sandbox')])
      
      await client.closeSandbox()
      const data3 = await client.query('select * from pg_promise_sandbox')
      
      return [data1, data2, data3]
    }

    const [
      [sandbox1a, sandbox1b, closed1], 
      [sandbox2a, sandbox2b, closed2]
    ] = await Promise.all([runInSandbox(), runInSandbox()])

    sandbox1a.should.eql(sandbox1b)
    sandbox1a[0].data.should.equal('test')

    sandbox2a.should.eql(sandbox2b)

    closed1.should.eql([])
    closed2.should.eql([])

  })

  it('nests transactions cleanly', async () => {
    const client = pgSandbox({pg, mode: 'sandbox'})      

    await client.createSandbox()
    let data1, data2
    await client.tx(async (t) => {
      await t.query('insert into pg_promise_sandbox(data) values ($(text))', {text: "test"})
      data1 = await t.query('select * from pg_promise_sandbox')
      await t.tx(async (t2) => {
        data2 = await t2.query('select * from pg_promise_sandbox')
      })
    }) 
    await client.closeSandbox()
    const data3 = await client.query('select * from pg_promise_sandbox')

    data1.should.eql(data2)
    data1[0].data.should.equal('test')
    data3.should.eql([])
  })

  it("rolls back when a transaction throws.", async () => {
    const client = pgSandbox({pg, mode: 'sandbox'})   
    await client.createSandbox()
    try {
      let data1, data2
      await client.tx(async (t) => {
        await t.query('insert into pg_promise_sandbox(data) values ($(text))', {text: "test"})
        data1 = await t.query('select * from pg_promise_sandbox')
        data2 = await t.query('select * from pg_promise_sandbox')
        throw new Error("failed transaction")
      }) 
      should.fail("Transactions that throw an error should not succeed")
    } catch (err) {
      err.message.should.eql("failed transaction")
    }
  })
})