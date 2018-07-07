var crypto = require('crypto')
var fs = require('mz/fs')
var zlib = require('mz/zlib')
var path = require('path')
var mime = require('mime-types')
var compressible = require('compressible')
// 递归读取目录
var readDir = require('fs-readdir-recursive')

var debug = require('debug')('koa-static-cache')

module.exports = function staticCache(dir, options, files) {
  if (typeof dir === 'object') {
    files = options
    options = dir
    dir = null
  }

  options = options || {}

  // prefix must be ASCII code
  // prefix: 想添加到url的前缀，默认为''
  options.prefix = (options.prefix || '').replace(/\/*$/, '/')
  files = new FileManager(files || options.files)
  dir = dir || options.dir || process.cwd()
  dir = path.normalize(dir)

  var enableGzip = !!options.gzip
  var filePrefix = path.normalize(options.prefix.replace(/^\//, ''))

  // option.filter
  var fileFilter = function () {
    return true
  }

  if (Array.isArray(options.filter)) {
    fileFilter = function (file) {
      return ~options.filter.indexOf(file)
    }
  }

  if (typeof options.filter === 'function') {
    fileFilter = options.filter
  }

  // 预加载，默认为true，常与dynamic一起使用
  // 预加载其实就是获取文件数据以及文件的相关信息，存储到一个对象中。
  if (options.preload !== false) {
    readDir(dir).filter(fileFilter).forEach(function (name) {
      loadFile(name, dir, options, files)
    })
  }

  // 别称
  if (options.alias) {
    Object.keys(options.alias).forEach(function (key) {
      var value = options.alias[key]

      if (files.get(value)) {
        files.set(key, files.get(value))

        debug('aliasing ' + value + ' as ' + key)
      }
    })
  }

  return async (ctx, next) => {
    // only accept HEAD and GET
    if (ctx.method !== 'HEAD' && ctx.method !== 'GET') return await next()
    // check prefix first to avoid calculate
    if (ctx.path.indexOf(options.prefix) !== 0) return await next()

    // decode for `/%E4%B8%AD%E6%96%87`
    // normalize for `//index`
    var filename = path.normalize(safeDecodeURIComponent(ctx.path))
    var file = files.get(filename)

    // try to load file
    // 尝试加载文件
    if (!file) {
      // dynamic：布尔值，true：表示动态加载资源，在初始化时没有缓存
      if (!options.dynamic) {
        return await next()
      }

      if (path.basename(filename)[0] === '.') {
        return await next()
      }

      // path.sep：提供平台定义的路径分割符号
      //  \ on Windows； / on POSIX
      // 如果文件的第一个字符是路径分割符，比如：filename = \\foo\\bar\\baz，那么就不要第一个字符
      // 即：filename = foo\\bar\\baz
      if (filename.charAt(0) === path.sep) {
        filename = filename.slice(1)
      }

      // trim prefix
      if (options.prefix !== '/') {
        if (filename.indexOf(filePrefix) !== 0) return await next()
        filename = filename.slice(filePrefix.length)
      }

      var fullpath = path.join(dir, filename)
      // files that can be accessd should be under options.dir
      if (fullpath.indexOf(dir) !== 0) {
        return await next()
      }

      var s
      try {
        s = await fs.stat(fullpath)
      } catch (err) {
        return await next()
      }
      if (!s.isFile()) return await next()

      file = loadFile(filename, dir, options, files)
    }

    ctx.status = 200

    if (enableGzip) ctx.vary('Accept-Encoding')

    // buffer：布尔值，true - 将文件存储在内存中，而不是每次请求都从文件系统中获取
    if (!file.buffer) {
      var stats = await fs.stat(file.path)
      // 文件的修改时间
      // 如果再次读取相同文件的时候，那么文件的修改时间会与之前保存的文件的修改时间作比较，如果新的大于旧的，那么md5则会被设置为null
      if (stats.mtime > file.mtime) {
        file.mtime = stats.mtime
        file.md5 = null
        file.length = stats.size
      }
    }

    // ctx.response里直接可以设置lastModified以及 etag 的值
    ctx.response.lastModified = file.mtime
    // md5存在，才设置etag
    if (file.md5) {
      ctx.response.etag = file.md5
    }

    // 检查请求缓存是否“新鲜”，也就是内容没有改变。
    // 此方法用于 If-None-Match / ETag, 和 If-Modified-Since 和 Last-Modified 之间的缓存协商。 在设置一个或多个这些响应头后应该引用它。
    if (ctx.fresh) {
      return ctx.status = 304
    }

    var filePath = file.path
    var fileType = file.type

    // 判断是否支持webp格式图片
    if (/\.(png|jpg)\.webp/g.test(filePath)) {
      var webpShow = ctx.cookies.get('webp_show')
      if (!webpShow) {
        filePath = filePath.replace(/\.webp$/, '')

        var etc = path.extname(filePath)

        fileType = (
          etc == '.png' ? 'image/png': 'image/jpeg'
        )
      }
    }

    ctx.type = fileType
    ctx.length = file.zipBuffer ? file.zipBuffer.length : file.length

    // 设置cache-control，默认是public，max-age=xxx
    // public：表明任何情况下都得缓存该资源（即使需要HTTP认证的资源）
    // max-age：告诉客户端该资源在xxx秒内是新鲜的，无需向服务器发请求
    // no-cache：不直接使用缓存，要想服务器发起请求（新鲜度校验）
    // no-store：所有文件都不会被保存到缓存或Internet临时文件中
    ctx.set('cache-control', file.cacheControl || 'public, max-age=' + file.maxAge)

    // content-md5标头和md5校验
    // 保证文件内容不会被任意篡改
    if (file.md5) {
      ctx.set('content-md5', file.md5)
    }

    if (ctx.method === 'HEAD') {
      return
    }

    var acceptGzip = ctx.acceptsEncodings('gzip') === 'gzip'

    if (file.zipBuffer) {
      if (acceptGzip) {
        ctx.set('content-encoding', 'gzip')
        ctx.body = file.zipBuffer
      } else {
        ctx.body = file.buffer
      }
      return
    }

    var shouldGzip = enableGzip
      && file.length > 1024
      && acceptGzip
      && compressible(file.type)

    if (file.buffer) {
      if (shouldGzip) {

        var gzFile = files.get(filename + '.gz')
        if (options.usePrecompiledGzip && gzFile && gzFile.buffer) { // if .gz file already read from disk
          file.zipBuffer = gzFile.buffer
        } else {
          file.zipBuffer = await zlib.gzip(file.buffer)
        }
        ctx.set('content-encoding', 'gzip')
        ctx.body = file.zipBuffer
      } else {
        ctx.body = file.buffer
      }
      return
    }

    var stream = fs.createReadStream(filePath)

    // update file hash
    // 更新文件的hash
    if (!file.md5) {
      var hash = crypto.createHash('md5')
      stream.on('data', hash.update.bind(hash))
      stream.on('end', function () {
        file.md5 = hash.digest('base64')
      })
    }

    ctx.body = stream
    // enable gzip will remove content length
    if (shouldGzip) {
      ctx.remove('content-length')
      ctx.set('content-encoding', 'gzip')
      ctx.body = stream.pipe(zlib.createGzip())
    }
  }
}

/**
 * 解码
 * @param text
 * @return {*}
 */
function safeDecodeURIComponent(text) {
  try {
    return decodeURIComponent(text)
  } catch (e) {
    return text
  }
}

/**
 * load file and add file content to cache
 * 加载文件以及添加文件内容到缓存里
 *
 * @param {String} name
 * @param {String} dir 文件目录
 * @param {Object} options 选项
 * @param {Object} files
 * @return {Object}
 * @api private
 */

function loadFile(name, dir, options, files) {
  // 文件路径
  var pathname = path.normalize(path.join(options.prefix, name))

  // 以文件路径作为键名，{}作为键值 - {'/path/xxx': {}}
  if (!files.get(pathname)) {
    files.set(pathname, {})
  }

  // 获取相应路径的对象
  var obj = files.get(pathname)
  // 文件完整路径
  var filename = obj.path = path.join(dir, name)
  // stats：文件的信息
  var stats = fs.statSync(filename)
  // 读取文件数据
  var buffer = fs.readFileSync(filename)

  obj.cacheControl = options.cacheControl
  // 文件的maxAge
  obj.maxAge = obj.maxAge ? obj.maxAge : options.maxAge || 0
  // 文件的mime类型
  obj.type = obj.mime = mime.lookup(pathname) || 'application/octet-stream'
  // 文件内容被修改的时间
  obj.mtime = stats.mtime
  // 文件的大小
  obj.length = stats.size

  // hash = createHash()：返回一个hash对象，使用被给予的算法生产hash摘要
  // hash.update(content)：根据内容，更新hash
  // hash.digest([encoding])：返回对应编码格式的字符
  obj.md5 = crypto.createHash('md5').update(buffer).digest('base64')

  // 调试
  debug('file: ' + JSON.stringify(obj, null, 2))

  if (options.buffer) {
    obj.buffer = buffer
  }

  buffer = null

  return obj
}

/**
 * 文件管理
 * @param store
 * @constructor
 */
function FileManager(store) {
  if (store && typeof store.set === 'function' && typeof store.get === 'function') {
    this.store = store
  } else {
    this.map = store || Object.create(null)
  }
}

FileManager.prototype.get = function (key) {
  return this.store ? this.store.get(key) : this.map[key]
}

FileManager.prototype.set = function (key, value) {
  if (this.store) {
    return this.store.set(key, value)
  }
  this.map[key] = value
}
