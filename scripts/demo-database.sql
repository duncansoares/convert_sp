/*
 * Demo fixtures for manually exercising convert-sp.
 *
 * Creates a database, a least-privilege SQL login, and a spread of procedures that
 * covers every classification the generator makes.
 *
 *   sqlcmd -S ".\SQLEXPRESS" -E -C -i scripts\demo-database.sql -b
 *
 * Safe to re-run: the database is dropped and recreated, and the login is reused.
 */
SET NOCOUNT ON;

IF DB_ID('convert_sp_demo') IS NOT NULL
BEGIN
    ALTER DATABASE convert_sp_demo SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE convert_sp_demo;
END;
GO

CREATE DATABASE convert_sp_demo;
GO

IF SUSER_ID('convert_sp_demo') IS NULL
    CREATE LOGIN convert_sp_demo
        WITH PASSWORD = 'Demo!Passw0rd#2026', CHECK_POLICY = OFF, CHECK_EXPIRATION = OFF;
GO

USE convert_sp_demo;
GO

CREATE SCHEMA sales;
GO

CREATE USER convert_sp_demo FOR LOGIN convert_sp_demo;
ALTER ROLE db_datareader ADD MEMBER convert_sp_demo;
ALTER ROLE db_datawriter ADD MEMBER convert_sp_demo;
GRANT EXECUTE ON SCHEMA::dbo TO convert_sp_demo;
GRANT EXECUTE ON SCHEMA::sales TO convert_sp_demo;
GRANT VIEW DEFINITION ON DATABASE::convert_sp_demo TO convert_sp_demo;
GO

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE dbo.Customer
(
    Id        int IDENTITY (1, 1) NOT NULL CONSTRAINT PK_Customer PRIMARY KEY,
    Name      nvarchar(100) NOT NULL,
    Email     nvarchar(128) NULL,
    Balance   decimal(18, 2) NOT NULL CONSTRAINT DF_Customer_Balance DEFAULT (0),
    IsActive  bit NOT NULL CONSTRAINT DF_Customer_IsActive DEFAULT (1),
    CreatedAt datetime2(0) NULL CONSTRAINT DF_Customer_CreatedAt DEFAULT (sysutcdatetime()),
    Notes     nvarchar(max) NULL
);
GO

CREATE TABLE dbo.OrderHeader
(
    Id         int IDENTITY (1, 1) NOT NULL CONSTRAINT PK_OrderHeader PRIMARY KEY,
    CustomerId int NOT NULL,
    Total      money NOT NULL CONSTRAINT DF_OrderHeader_Total DEFAULT (0),
    PlacedAt   datetime2(0) NOT NULL CONSTRAINT DF_OrderHeader_PlacedAt DEFAULT (sysutcdatetime())
);
GO

CREATE TABLE dbo.OrderLine
(
    OrderId int NOT NULL,
    LineNumber  smallint NOT NULL,
    Qty     smallint NOT NULL,
    Price   money NOT NULL,
    CONSTRAINT PK_OrderLine PRIMARY KEY (OrderId, LineNumber)
);
GO

CREATE TABLE dbo.ImportStaging
(
    Value int NOT NULL
);
GO

CREATE TABLE sales.AuditLog
(
    AuditId bigint IDENTITY (1, 1) NOT NULL CONSTRAINT PK_AuditLog PRIMARY KEY,
    Event   varchar(100) NOT NULL,
    Detail  nvarchar(max) NULL,
    LoggedAt datetime2(0) NOT NULL CONSTRAINT DF_AuditLog_LoggedAt DEFAULT (sysutcdatetime())
);
GO

-- ---------------------------------------------------------------------------
-- Single-table procedures -> table repository
-- ---------------------------------------------------------------------------

CREATE PROCEDURE dbo.usp_Customer_GetById
    @CustomerId int
AS
BEGIN
    SET NOCOUNT ON;
    SELECT c.Id, c.Name, c.Email, c.Balance, c.IsActive, c.CreatedAt
    FROM dbo.Customer AS c
    WHERE c.Id = @CustomerId;
END;
GO

CREATE PROCEDURE dbo.usp_Customer_List
AS
BEGIN
    SET NOCOUNT ON;
    SELECT c.Id, c.Name, c.Email, c.Balance, c.IsActive
    FROM dbo.Customer AS c
    ORDER BY c.Name;
END;
GO

-- Seven parameters, all optional -> one params object.
CREATE PROCEDURE dbo.usp_Customer_Search
    @Term         nvarchar(100) = NULL,
    @Page         int = 1,
    @Size         int = 20,
    @Sort         nvarchar(50) = NULL,
    @Active       bit = NULL,
    @CreatedAfter datetime2(0) = NULL,
    @Email        nvarchar(128) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT c.Id, c.Name, c.Email, c.Balance, c.IsActive
    FROM dbo.Customer AS c
    WHERE (@Term IS NULL OR c.Name LIKE '%' + @Term + '%')
      AND (@Active IS NULL OR c.IsActive = @Active)
      AND (@Email IS NULL OR c.Email = @Email)
      AND (@CreatedAfter IS NULL OR c.CreatedAt >= @CreatedAfter)
    ORDER BY c.Id
    OFFSET (@Page - 1) * @Size ROWS FETCH NEXT @Size ROWS ONLY;
END;
GO

CREATE PROCEDURE dbo.usp_Customer_Create
    @Name  nvarchar(100),
    @Email nvarchar(128) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO dbo.Customer (Name, Email)
    VALUES (@Name, @Email);

    SELECT c.Id, c.Name, c.Email, c.Balance, c.IsActive
    FROM dbo.Customer AS c
    WHERE c.Id = SCOPE_IDENTITY();
END;
GO

CREATE PROCEDURE dbo.usp_Customer_UpdateBalance
    @CustomerId int,
    @Delta      decimal(18, 2)
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE dbo.Customer
    SET Balance = Balance + @Delta
    WHERE Id = @CustomerId;

    SELECT c.Id, c.Balance FROM dbo.Customer AS c WHERE c.Id = @CustomerId;
END;
GO

CREATE PROCEDURE dbo.usp_Customer_Deactivate
    @CustomerId int
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE dbo.Customer SET IsActive = 0 WHERE Id = @CustomerId;
END;
GO

CREATE PROCEDURE dbo.usp_Customer_Delete
    @CustomerId int
AS
BEGIN
    SET NOCOUNT ON;
    DELETE FROM dbo.Customer WHERE Id = @CustomerId;
END;
GO

-- Seven parameters: DELETE would need a body, so the controller uses POST.
CREATE PROCEDURE dbo.usp_Customer_Purge
    @Id     int,
    @Reason nvarchar(200),
    @A      int,
    @B      int,
    @C      int,
    @D      int,
    @E      int
AS
BEGIN
    SET NOCOUNT ON;
    DELETE FROM dbo.Customer WHERE Id = @Id;
END;
GO

CREATE PROCEDURE dbo.usp_Customer_Cte
AS
BEGIN
    SET NOCOUNT ON;
    WITH recent AS (
        SELECT c.Id, c.Name FROM dbo.Customer AS c WHERE c.CreatedAt IS NOT NULL
    )
    SELECT recent.Id, recent.Name FROM recent;
END;
GO

-- OUTPUT parameter: generated method returns rows only, report carries a warning.
CREATE PROCEDURE dbo.usp_Customer_Stats
    @CustomerId int,
    @OrderCount int OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SELECT @OrderCount = COUNT(*) FROM dbo.OrderHeader AS o WHERE o.CustomerId = @CustomerId;

    SELECT c.Id, c.Name, c.Balance
    FROM dbo.Customer AS c
    WHERE c.Id = @CustomerId;
END;
GO

-- No primary key: repository gets row handling but no TypeORM entity.
CREATE PROCEDURE dbo.usp_Import_Stage
    @Value int
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO dbo.ImportStaging (Value) VALUES (@Value);
END;
GO

CREATE PROCEDURE dbo.usp_Import_Clear
AS
BEGIN
    SET NOCOUNT ON;
    TRUNCATE TABLE dbo.ImportStaging;
END;
GO

-- ---------------------------------------------------------------------------
-- Multi-table procedures -> service with several repositories
-- ---------------------------------------------------------------------------

CREATE PROCEDURE dbo.usp_Order_Place
    @CustomerId int,
    @Total      money
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO dbo.OrderHeader (CustomerId, Total) VALUES (@CustomerId, @Total);

    DECLARE @OrderId int = SCOPE_IDENTITY();

    INSERT INTO sales.AuditLog (Event, Detail)
    VALUES ('OrderPlaced', CONCAT('order=', @OrderId, ' customer=', @CustomerId));

    SELECT o.Id, o.CustomerId, o.Total, o.PlacedAt
    FROM dbo.OrderHeader AS o
    WHERE o.Id = @OrderId;
END;
GO

CREATE PROCEDURE dbo.usp_Order_AddLine
    @OrderId int,
    @LineNumber  smallint,
    @Qty     smallint,
    @Price   money
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO dbo.OrderLine (OrderId, LineNumber, Qty, Price)
    VALUES (@OrderId, @LineNumber, @Qty, @Price);

    UPDATE dbo.OrderHeader
    SET Total = Total + (@Qty * @Price)
    WHERE Id = @OrderId;

    SELECT l.OrderId, l.LineNumber, l.Qty, l.Price
    FROM dbo.OrderLine AS l
    WHERE l.OrderId = @OrderId AND l.LineNumber = @LineNumber;
END;
GO

-- Writes beat deletes, so this is a post on a multi-table service.
CREATE PROCEDURE dbo.usp_Customer_Archive
    @CustomerId int
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO sales.AuditLog (Event, Detail)
    VALUES ('CustomerArchived', CONCAT('customer=', @CustomerId));

    DELETE FROM dbo.Customer WHERE Id = @CustomerId;
END;
GO

-- ---------------------------------------------------------------------------
-- Other schema, skipped procedures
-- ---------------------------------------------------------------------------

CREATE PROCEDURE sales.usp_Audit_List
    @From bigint = 0
AS
BEGIN
    SET NOCOUNT ON;
    SELECT a.AuditId, a.Event, a.Detail, a.LoggedAt
    FROM sales.AuditLog AS a
    WHERE a.AuditId > @From
    ORDER BY a.AuditId;
END;
GO

CREATE PROCEDURE dbo.usp_Dynamic_Report
    @TableName sysname
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @sql nvarchar(max) = N'SELECT COUNT(*) AS c FROM ' + QUOTENAME(@TableName);
    EXEC sp_executesql @sql;
END;
GO

CREATE PROCEDURE dbo.usp_Ping
AS
BEGIN
    SELECT 1 AS ok;
END;
GO

-- ---------------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------------

INSERT INTO dbo.Customer (Name, Email, Balance, IsActive)
VALUES (N'Ada Lovelace', N'ada@example.com', 120.50, 1),
       (N'Grace Hopper', N'grace@example.com', 0, 1),
       (N'Katherine Johnson', NULL, 42.00, 0);
GO

INSERT INTO dbo.OrderHeader (CustomerId, Total) VALUES (1, 60.00), (1, 60.50);
INSERT INTO dbo.OrderLine (OrderId, LineNumber, Qty, Price) VALUES (1, 1, 2, 30.00), (2, 1, 1, 60.50);
INSERT INTO sales.AuditLog (Event, Detail) VALUES ('Seed', N'created by demo-database.sql');
GO

PRINT 'convert_sp_demo ready: login=convert_sp_demo db=convert_sp_demo';
