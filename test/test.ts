import 'mocha';

import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import * as sinon from 'sinon';
import * as sinonChai from 'sinon-chai';

chai.use(sinonChai);
chai.use(chaiAsPromised);
chai.should();
const expect = chai.expect;

import { Async } from 'async-test-tools';
import Retrier from '../src/retrier';
import { Backoff } from '../src/retrier';

describe('Retrier', () => {
  let mockClock;

  beforeEach(() => {
    mockClock = sinon.useFakeTimers(new Date().getTime());
  });

  afterEach(() => {
    mockClock.restore();
  });

  it('Should immediately call a function', () => {
    let retrier = new Retrier({min: 10, max: 1000});

    let called = false;
    retrier.on('attempt', () => {
      called = true;
    });
    retrier.start();

    mockClock.tick(0);
    expect(called).to.equal(true);
  });

  it('Should repsect an initial delay', () => {
    let retrier = new Retrier({min: 10, max: 1000, initial: 100});

    let called = false;
    retrier.on('attempt', () => {
      called = true;
    });
    retrier.start();

    mockClock.tick(50);
    expect(called).to.equal(false);
    mockClock.tick(60);
    expect(called).to.equal(true);
  });

  it('when succeeded should fire a "succeeded" event and resolve a promise', () => {
    let retrier = new Retrier({min: 10, max: 1000});
    let result = retrier.start();
    retrier.on('attempt', () => {
      retrier.succeeded({code: 200, message: 'OK'});
    });

    mockClock.tick(0);
    return expect(result).to.become({code: 200, message: 'OK'});
  });

  it('when cancelled should fire a "cancelled" event and reject a promise', () => {
    let retrier = new Retrier({min: 10, max: 1000, initial: 100});

    let called = false;
    retrier.on('attempt', () => {
      called = true;
    });
    let retrierResult = retrier.start();

    mockClock.tick(50);
    expect(called).to.equal(false);

    retrier.cancel();

    mockClock.tick(60);
    expect(called).to.equal(false); // attempt is not called
    return expect(retrierResult).to.be.rejected;
  });

  it('when failure reported should retry', () => {
    let retrier = new Retrier({min: 10, max: 1000});

    let myspy = sinon.stub();
    myspy
        .onFirstCall().returns(Promise.reject({code: 503, message: 'Server unavailable'}))
        .onSecondCall().returns(Promise.reject({code: 503, message: 'Server unavailable'}))
        .onThirdCall().returns(Promise.resolve({code: 200, message: 'OK'}));

    retrier.on('attempt', () => myspy()
        .then(res => retrier.succeeded(res))
        .catch(err => retrier.failed(err)));

    let retrierResult = retrier.start();

    return Async.sequence([
      () => {
        mockClock.tick(0);
      },
      () => {
        mockClock.tick(20);
      },
      () => {
        mockClock.tick(20);
      }
    ]);
  });

  it('when failed should respect delay override', () => {
    let retrier = new Retrier({min: 10, max: 20});

    let myspy = sinon.stub();
    myspy
        .onFirstCall().returns(Promise.reject({code: 503, message: 'Server unavailable'}))
        .onSecondCall().returns(Promise.resolve({code: 200, message: 'OK'}));

    retrier.on('attempt', () => myspy()
        .then(res => retrier.succeeded(res))
        .catch(err => retrier.failed(err, 300)));

    let retrierResult = retrier.start();

    return Async.sequence([
      () => {
        expect(myspy).to.have.not.been.called;
        mockClock.tick(0);
        expect(myspy).to.have.been.calledOnce;
      },
      () => {
        mockClock.tick(50);
        expect(myspy).to.have.been.calledOnce;
        mockClock.tick(250);
        expect(myspy).to.have.been.calledTwice;
      }
    ]);
  });

  it('should stop retrying after the maximum attempt time limit is reached', async () => {
    let retrier = new Retrier({min: 5, max: 10, maxAttemptsTime: 30});
    let myspy = sinon.stub();
    myspy.onCall(0).returns(Promise.reject({code: 503, message: 'Server unavailable'}));
    myspy.onCall(1).returns(Promise.reject({code: 503, message: 'Server unavailable'}));
    myspy.onCall(2).returns(Promise.reject({code: 503, message: 'Server unavailable'}));

    retrier.on('attempt', () => myspy()
        .then(res => retrier.succeeded(res))
        .catch(err => retrier.failed(err)));
    let failedCallback = sinon.spy();
    retrier.on('failed', failedCallback);
    retrier.start();
    return Async.sequence([
      () => {
        mockClock.tick(30);
      },
      () => {
        expect(failedCallback.getCall(0).args[0].message).to.equal('Maximum attempt time limit reached');
        mockClock.tick(90);
      },
      () => {
        expect(myspy).to.have.been.calledOnce;
      }]);
  });

  describe('Promise interface', () => {
    it('resolves when underlying promise is resolved', () => {
      mockClock.restore();
      let myspy = sinon.stub();
      myspy
          .onFirstCall().returns(Promise.reject({code: 503, message: 'Server unavailable'}))
          .onSecondCall().returns(Promise.reject({code: 503, message: 'Server unavailable'}))
          .onThirdCall().returns(Promise.resolve({code: 200, message: 'OK'}));

      return new Retrier({min: 10, max: 1000})
          .run(myspy).should.be.fulfilled;
    });

    it('rejects if maximum attempts count reached', () => {
      mockClock.restore();
      let myspy = sinon.stub();
      myspy
          .onFirstCall().returns(Promise.reject({code: 503, message: 'Server unavailable'}))
          .onSecondCall().returns(Promise.reject({code: 503, message: 'Server unavailable'}))
          .onThirdCall().returns(Promise.resolve({code: 200, message: 'OK'}));

      return new Retrier({min: 10, max: 100, maxAttemptsCount: 2}).run(myspy).should.be.rejected;
    });

    it('rejects if maximum attempts time reached', () => {
      mockClock.restore();
      let myspy = sinon.stub();
      myspy
          .onFirstCall().returns(Promise.reject({code: 503, message: 'Server unavailable'}))
          .onSecondCall().returns(Promise.reject({code: 503, message: 'Server unavailable'}))
          .onThirdCall().returns(Promise.resolve({code: 200, message: 'OK'}));

      return new Retrier({min: 10, max: 100, maxAttemptsTime: 1}).run(myspy).should.be.rejected;
    });
  });

  describe('Backoff', function () {
    const exponentialDelays = [10, 20, 40, 80, 160, 320, 640, 1000, 1000, 1000];

    let backoff;
    let backoffCallback;
    let readyCallback;
    let failCallback;

    function testFunc(initOptions, expectedMesage) {
      try {
        backoff = Backoff.exponential(initOptions);
        throw new Error(`Unexpected test pass for init options ${JSON.stringify(initOptions)}`);
      } catch (err) {
        expect(err.message).to.equal(expectedMesage);
      }
    }

    beforeEach(() => {
      backoffCallback = sinon.spy();
      readyCallback = sinon.spy();
      failCallback = sinon.spy();
      backoff = Backoff.exponential({
        initialDelay: 10,
        maxDelay: 1000
      });
      backoff.on('backoff', backoffCallback);
      backoff.on('ready', readyCallback);
      backoff.on('fail', failCallback);
    });

    it('should emit the \'backoff\' event when backoff starts', () => {
      backoff.backoff();
      expect(backoffCallback).to.have.been.calledOnce;
    });

    it('the ready event should be emitted on backoff completion', () => {
      backoff.backoff();
      mockClock.tick(10);
      expect(readyCallback).to.have.been.calledOnce;
    });

    it('the backoff event should be passed the backoff number and backoff delay', () => {
      backoff.backoff();
      expect(backoffCallback).to.have.been.calledWith(0, 10);
    });

    it('the ready event should be passed backoff number and the backoff delay', () => {
      backoff.backoff();
      mockClock.tick(10);
      expect(readyCallback).to.have.been.calledWith(0, 10);
    });

    it('the fail event should be emitted when backoff limit is reached', () => {
      let error = new Error('Failure error.');
      backoff.failAfter(2);
      backoff.backoff();
      mockClock.tick(10);
      backoff.backoff();
      mockClock.tick(20);

      expect(failCallback).not.to.have.been.called;
      backoff.backoff(error);
      expect(failCallback).to.have.been.calledWith(error);
      mockClock.tick(20);
      expect(backoffCallback).to.have.been.calledTwice;
    });

    it('calling backoff while a backoff is in progress should do nothing', () => {
      backoff.backoff();
      backoff.backoff();
      expect(backoffCallback).to.have.been.calledOnce;
      expect(failCallback).not.to.have.been.called;
    });

    it('reset should cancel any backoff in progress', () => {
      backoff.backoff();
      backoff.reset();

      mockClock.tick(10);
      expect(readyCallback).not.to.have.been.called;
    });

    it('backoff should be reset after fail', () => {
      sinon.spy(backoff, 'reset');

      backoff.failAfter(1);
      backoff.backoff();
      mockClock.tick(10);
      backoff.backoff();

      expect(backoff.reset).to.have.been.calledOnce;
      backoff.reset.restore();
    });

    it('backoff limit should be greater than 0', () => {
      try {
        backoff.failAfter(0);
        expect.fail('Calling backoff.failAfter with 0 should have thrown an error!');
      } catch (err) {
        expect(err.message).to.equal('Expected a maximum number of retry greater than 0 but got 0');
      }
    });

    it('the backoff number should increase from 0 to N - 1', () => {
      const expectedNumbers = [0, 1, 2, 3, 4];

      for (let i of expectedNumbers) {
        backoff.backoff();
        mockClock.tick(backoff.next());
        expect(backoffCallback.getCall(i).args[0]).to.equal(i);
      }
    });

    it('the randomisation factor should be between 0 and 1', () => {
      testFunc({randomisationFactor: 1.1}, 'The randomisation factor must be between 0 and 1.');
      testFunc({randomisationFactor: -0.1}, 'The randomisation factor must be between 0 and 1.');
    });

    it('the raw delay should be randomized based on the randomisation factor', () => {
      backoff = Backoff.exponential({
        randomisationFactor: 0.5,
        initialDelay: 10,
        maxDelay: 1000
      });
      let previous = 10;
      let randomizedDelays = [];
      for (let i = 0; i < 10; i++) {
        let next = backoff.next();
        randomizedDelays.push(next);
        expect(next).to.be.at.least(previous);
        expect(next).to.be.below(1201);
        expect(next).to.be.at.least(10);
        previous = next;
      }
      let randomizedUniqueValues = randomizedDelays.filter((element, index) => element !== exponentialDelays[index]);
      expect(randomizedUniqueValues.length).to.be.at.least(1);
    });

    it('the initial backoff delay should be equal to or greater than 1.', () => {
      testFunc({initialDelay: -0.1}, 'The initial timeout must be equal to or greater than 1.');
      testFunc({initialDelay: 0}, 'The initial timeout must be equal to or greater than 1.');
    });

    it('the maximal backoff delay should be equal to or greater than 1.', () => {
      testFunc({maxDelay: -0.1}, 'The maximal timeout must be equal to or greater than 1.');
      testFunc({maxDelay: 0}, 'The maximal timeout must be equal to or greater than 1.');
    });

    it('the maximal backoff delay should be greater than the initial backoff delay', () => {
      testFunc({
        maxDelay: 5,
        initialDelay: 10
      }, 'The maximal backoff delay must be greater than the initial backoff delay.');

    });

    it('delays should follow an exponential sequence', () => {
      for (let delay of exponentialDelays) {
        expect(backoff.next()).to.equal(delay);
      }
    });

    it('delay factor should be configurable', () => {
      backoff = Backoff.exponential({
        initialDelay: 10,
        maxDelay: 270,
        factor: 3
      });
      const expectedDelays = [10, 30, 90, 270, 270];
      for (let delay of expectedDelays) {
        expect(backoff.next()).to.equal(delay);
      }
    });

    it('delays should restart from the initial delay after reset', () => {
      backoff.next();
      backoff.next();

      expect(backoff.next()).to.equal(40);
      backoff.reset();
      expect(backoff.next()).to.equal(10);
    });

    it('should be in a clean state after reset', () => {
      backoff.backoff();
      mockClock.tick(10);
      expect(readyCallback).to.have.been.calledWith(0, 10);
      backoff.backoff();
      mockClock.tick(20);
      expect(readyCallback).to.have.been.calledWith(1, 20);
      backoff.backoff();
      mockClock.tick(40);
      expect(readyCallback).to.have.been.calledWith(2, 40);

      backoff.reset();

      backoff.backoff();
      mockClock.tick(10);
      expect(readyCallback).to.have.been.calledWith(0, 10);
    });
  });
});
