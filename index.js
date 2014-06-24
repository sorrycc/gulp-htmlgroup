var through = require('through2');
var cheerio = require('cheerio');
var async = require('async');
var EventProxy = require('eventproxy');
var request = require('request');
var debug = require('debug')('htmlgroup');
var join = require('path').join;
var write = require('fs').writeFileSync;
var util = require('util');

module.exports = function(uploadEngine) {

  function upload(str, ext, cb) {
    var filename = +new Date() + Math.floor(Math.random() * 1000);
    var filepath = join(process.env.TMPDIR, filename+'.'+ext);

    write(filepath, str);
    uploadEngine(filepath, cb);
  }

  return through.obj(function(file, enc, callback) {
    var html = file.contents.toString();

    var groups = {
      css: {},
      js : {}
    };

    // get css and js groups
    addGroup('link[rel=stylesheet][group]', 'css', 'href', groups, html);
    addGroup('script[group]', 'js', 'src', groups, html);

    groups = normalize(groups);

    function done() {
      file.contents = new Buffer(html);
      callback(null, file);
    }

    // do group
    if (groups && groups.length) {
      var ep = new EventProxy();
      ep.after('group', groups.length, function() {
        done();
      });

      groups.forEach(function(group) {
        runGroup(group, function(_html) {
          html = _html;
          ep.emit('group');
        });
      });

    } else {
      return done();
    }

    // Group steps:
    // 1. concat remote assets
    // 2. upload to cdn
    // 3. replace html
    function runGroup(group, cb) {
      async.waterfall([
        function(next) {
          debug('get data: %s', group.urls.join(','));
          getData(group.urls, next);
        },
        function(data, next) {
          upload(data, group.type, next);
        },
        function(url) {
          debug('replace url: %s', url);
          if (util.isArray(url)) {
            url = url[0];
          }
          cb(groupHTML(html, url, group.type, group.urls, group.name));
        }
      ]);
    }

  });
};

// Parse html and add group to groups variable
function addGroup(selector, type, assetAttr, groups, html) {
  var $ = cheerio.load(html);
  var els = $(selector);
  els.each(function() {
    var group = $(this).attr('group');
    if (!groups[type][group]) {
      groups[type][group] = [];
    }
    groups[type][group].push($(this).attr(assetAttr));
  });
}

// Format groups, from Object to Array
function normalize(groups) {
  var ret = [];
  for (var type in groups) {
    var groupsInType = groups[type];
    for (var name in groupsInType) {
      var urls = groupsInType[name];
      // don't group group that has only 1 css or js
      if (urls.length >= 2) {
        ret.push({type:type,name:name,urls:urls});
      }
    }
  }
  return ret;
}

function getData(urls, cb) {
  if (!util.isArray(urls)) {
    urls = [urls];
  }
  async.concatSeries(urls, function(url, next) {
    request(url, function(err, res, body) {
      next(err, body);
    });
  }, function(err, files) {
    cb(err, files && files.join('\n'));
  });
}

function groupHTML(html, newUrl, type, urls, group) {
  if (type !== 'css' && type !== 'js') {
    throw Error('known type: ' + type);
  }

  function getRegexp(url) {
    if (type === 'css') {
      return new RegExp('<link[^>]+?'+url+'.*?>', 'i');
    } else {
      return new RegExp('<script[^>]+?'+url+'.+?<\/script>', 'i');
    }
  }

  function getNewStr(str, index, type, newUrl) {
    if (index !== 0) return '';

    var tag  = type === 'css' ? 'link' : 'script';
    var attr = type === 'css' ? 'href' : 'src';

    var $ = cheerio.load(str);
    $(tag).attr(attr, newUrl);

    return $.html();
  }

  urls.forEach(function(url, index) {
    var newSubStr = '';
    var groupInfo = group ? ' group="'+group+'"' : '';
    if (index === 0) {
      newSubStr = type === 'css' ? '<link'+groupInfo+' rel="stylesheet" href="'+newUrl+'" />'
        : '<script'+groupInfo+' src="'+newUrl+'"></script>';
    }
    var re = getRegexp(url);
    html = html.replace(re, function(str) {
      return getNewStr(str, index, type, newUrl);
    });
  });

  return html;
}
